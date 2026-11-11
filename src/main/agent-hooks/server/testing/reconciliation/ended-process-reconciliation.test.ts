import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, postHookEvent } from '../server.test-fixtures'

import {
  attestFixtureHookContext,
  FIXTURE_LAUNCH_TOKEN
} from '../attested-hook-context.test-fixtures'
const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab-1', LEAF)

let dir: string
const servers = new Set<AgentHookServer>()

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-ended-process-'))
})

afterEach(() => {
  for (const server of servers) {
    server.stop()
  }
  servers.clear()
  rmSync(dir, { recursive: true, force: true })
})

async function startServer(): Promise<AgentHookServer> {
  const server = attestFixtureHookContext(new AgentHookServer())
  servers.add(server)
  await server.start({ env: 'production', userDataPath: dir })
  return server
}

// Fork 6d65165647: terminal and relayed Claude status is refused without attestation, so these
// rows come from attested local hooks.
async function claudeRow(server: AgentHookServer, state: 'working' | 'done'): Promise<void> {
  const events = [
    { hook_event_name: 'UserPromptSubmit', prompt: 'review the PR' },
    ...(state === 'done' ? [{ hook_event_name: 'Stop' }] : [])
  ]
  for (const payload of events) {
    expect((await postHookEvent(server, buildBody(payload))).status).toBe(204)
  }
  expect(paneState(server)).toBe(state)
}

// Its fixture launch token stands in for the dead launch the relay used to carry.
async function resumableClaudeRow(server: AgentHookServer): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'resume-me',
      prompt: 'review the PR'
    })
  )
  expect(response.status).toBe(204)
  expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
    providerSession: { id: 'resume-me' },
    launchToken: FIXTURE_LAUNCH_TOKEN
  })
}

function paneState(server: AgentHookServer): string {
  return server.getStatusSnapshotForPane(PANE)[0]?.state ?? 'missing'
}

// Restored PTYs may lack spawn-time mappings, so ordinary teardown cannot retire their stale rows.
describe('reconcileEndedProcessForPaneKeys', () => {
  it('clears Claude latches even when the stored row already reads done', async () => {
    // Stale latches can re-gate a done row on the next event.
    const server = await startServer()
    try {
      await claudeRow(server, 'done')
      server._getStateForTests().claudeRunningNonAgentTaskPaneKeys.add(PANE)
      server._getStateForTests().claudeActiveSessionCronPaneKeys.add(PANE)

      expect(server.reconcileEndedProcessForPaneKeys([PANE])).toBe(1)

      expect(server._getStateForTests().claudeRunningNonAgentTaskPaneKeys.has(PANE)).toBe(false)
      expect(server._getStateForTests().claudeActiveSessionCronPaneKeys.has(PANE)).toBe(false)
      const response = await postHookEvent(server, buildBody({ hook_event_name: 'Stop' }))
      expect(response.status).toBe(204)
      expect(paneState(server)).toBe('done')
    } finally {
      server.stop()
    }
  })

  it('keeps the resume identity a paired dismissal minted when the shell outlived the agent', async () => {
    // Paired dismissal preserves resume identity; retire live claims without discarding that remnant.
    const server = await startServer()
    try {
      await resumableClaudeRow(server)
      server.dropStatusEntry(PANE)
      const afterDrop = server.getStatusSnapshotForPane(PANE)[0]
      expect(afterDrop?.providerSessionOnly).toBe(true)
      expect(afterDrop?.providerSession?.id).toBe('resume-me')

      expect(
        server.reconcileEndedProcessForPaneKeys([PANE], { preserveResumeIdentity: true })
      ).toBe(1)

      const kept = server.getStatusSnapshotForPane(PANE)[0]
      expect(kept?.providerSessionOnly).toBe(true)
      expect(kept?.providerSession?.id).toBe('resume-me')
      expect(kept?.launchToken).toBeUndefined()
      expect(server._getStateForTests().claudeRunningNonAgentTaskPaneKeys.has(PANE)).toBe(false)

      // Resume identity must not restore dead process authority.
      server.flushStatusPersistSync()
      server.stop()
      const restarted = await startServer()
      expect(restarted.getStatusSnapshotForPane(PANE)[0]?.launchToken).toBeUndefined()
      expect(restarted.getHydratedAuthorityCommitments()).toHaveLength(0)
      restarted.stop()
    } finally {
      server.stop()
    }
  })

  it('drops the session owner so a rebound pane is not read as a session replacement', async () => {
    const server = await startServer()
    try {
      await claudeRow(server, 'working')
      server._getStateForTests().claudeSessionOwnerByPaneKey.set(PANE, 'session-a')

      server.reconcileEndedProcessForPaneKeys([PANE])

      expect(server._getStateForTests().claudeSessionOwnerByPaneKey.has(PANE)).toBe(false)
      // A fresh unanchored cron must survive the new owner's first lead event.
      for (const payload of [
        { hook_event_name: 'Stop', session_crons: [{ id: 'new-cron' }] },
        { hook_event_name: 'PostToolUse', session_id: 'session-b', tool_name: 'Bash' },
        { hook_event_name: 'Stop', session_id: 'session-b' }
      ]) {
        const response = await postHookEvent(server, buildBody(payload))
        expect(response.status).toBe(204)
      }
      expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
        state: 'working',
        workingMode: 'monitoring',
        mainAgent: { state: 'done' }
      })
    } finally {
      server.stop()
    }
  })
})
