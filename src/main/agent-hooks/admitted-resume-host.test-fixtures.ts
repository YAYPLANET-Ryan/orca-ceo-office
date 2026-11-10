import '../daemon/pty-subprocess/testing/mock-descendant-sweep'
import { realpath } from 'node:fs/promises'
import { normalize } from 'node:path'
import type { AgentHookServer } from './server/agent-hook-server'
import type { Body } from './server/testing/server.test-fixtures'
import { TerminalHost } from '../daemon/terminal-host/terminal-host'
import { createMockSubprocess } from '../daemon/providers/adapter/testing/daemon-pty-adapter-test-harness'
import type { HookContextSnapshotReader } from './server/hook-context-snapshot'
import type { HookProviderObservation } from '../../shared/agent-hook-listener/state/hook-provider-observation'
import type { ProviderObservationWriter } from './server/provider-observation-queue'
import { PANE, postHookEvent } from './server/testing/server.test-fixtures'
import { composeWorktreeId } from '../../shared/worktree/id'

export async function postAdmittedFixtureHook(server: AgentHookServer, body: Body, path: string) {
  return (await postHookEvent(server, body, path)).status
}

export async function createAdmittedResumeHost(root: string, agentType: 'claude' | 'codex') {
  const subprocess = createMockSubprocess()
  const host = new TerminalHost({ spawnSubprocess: () => subprocess })
  async function dispose(): Promise<void> {
    const errors: unknown[] = []
    try {
      subprocess._simulateExit(0)
    } catch (error) {
      errors.push(error)
    }
    try {
      await host.dispose()
    } catch (error) {
      errors.push(error)
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'Own admitted host fixture cleanup failed')
    }
  }
  try {
    const cwd = normalize(await realpath(root))
    const worktreeId = composeWorktreeId('synthetic-repo', root)
    const created = await host.createOrAttach({
      sessionId: `${worktreeId}@@synthetic-owned-pty`,
      cwd: root,
      cols: 80,
      rows: 24,
      launchAgent: agentType,
      hookResumeIntent: { agentType, providerSessionId: 'original-conversation' },
      env: {
        ORCA_AGENT_HOOK_OWNER: 'a'.repeat(64),
        ORCA_AGENT_LAUNCH_TOKEN: 'abc',
        ORCA_PANE_KEY: PANE
      },
      streamClient: { onData() {}, onExit() {} }
    })
    const observations: HookProviderObservation[] = []
    const read: HookContextSnapshotReader = async (envelope) => {
      const row = host.listSessions()[0]
      const context = row?.hookContext
      if (!row?.incarnationId || !context) {
        return null
      }
      return {
        executionHostId: 'local',
        paneKey: PANE,
        worktreeId,
        ptyId: row.sessionId,
        incarnationId: row.incarnationId,
        launchTokenHash: context.launchTokenHash,
        ownerClientInstanceId: context.ownerClientInstanceId,
        launchCwd: context.cwd,
        cwd,
        reportedCwd:
          typeof envelope.hookPayloadRecord.cwd === 'string' ? envelope.hookPayloadRecord.cwd : '',
        resumeIntent: context.resumeIntent,
        providerObservation: row.providerObservation
      }
    }
    const write: ProviderObservationWriter = async (update) => {
      const observation = await host.recordProviderObservation(update, created.attachToken)
      observations.push(observation)
      return observation
    }
    return {
      worktreeId,
      cwd,
      read,
      write,
      observations,
      incarnationId: created.incarnationId,
      dispose
    }
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Own admitted host fixture cleanup failed')
    }
    throw error
  }
}
