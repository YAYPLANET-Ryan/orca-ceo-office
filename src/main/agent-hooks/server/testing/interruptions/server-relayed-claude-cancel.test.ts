// Replay captured cancels over SSH; the relay never sees desktop Ctrl+C inference and may restate stale main-agent work.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../../../../wsl-guest/agent-hook-server'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, PANE } from '../server.test-fixtures'
import { hookAt, loadCapture, type CapturedHook } from './claude-cancel-capture.test-fixture'

import { attestFixtureHookContext } from '../attested-hook-context.test-fixtures'
const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../../../../telemetry/client', () => ({ track: trackMock }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const temporaryPaths: string[] = []
const running: { stop: () => void }[] = []

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  for (const server of running.splice(0)) {
    server.stop()
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

function temporaryDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  temporaryPaths.push(path)
  return path
}

type SshPane = {
  relay: RelayAgentHookServer
  desktop: AgentHookServer
  post: (payload: Record<string, unknown>) => Promise<void>
}

function createRelay(forwardTo: () => AgentHookServer): RelayAgentHookServer {
  return new RelayAgentHookServer({
    endpointDir: temporaryDir('orca-relayed-cancel-'),
    token: 'relayed-cancel-token',
    forward: (envelope) => forwardTo().ingestRemote(envelope, 'conn-1')
  })
}

async function startSshPane(desktop: AgentHookServer): Promise<SshPane> {
  const pane: SshPane = {
    desktop,
    relay: createRelay(() => pane.desktop),
    post: async (payload) => {
      const { port, token } = pane.relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify(buildBody(payload))
      })
      expect(response.status).toBe(204)
    }
  }
  running.push(pane.relay, desktop)
  await pane.relay.start({ publishEndpoint: false })
  return pane
}

/** Restart relay state while the remote agent keeps running. */
async function restartRelay(pane: SshPane): Promise<void> {
  pane.relay.stop()
  pane.relay = createRelay(() => pane.desktop)
  running.push(pane.relay)
  await pane.relay.start({ publishEndpoint: false })
}

async function postCaptured(pane: SshPane, hooks: CapturedHook[]): Promise<void> {
  for (const hook of hooks) {
    await pane.post(hook.payload)
  }
}

function rejections(server: AgentHookServer): number {
  return server.getContextIntegrityRejections().remote_context_attestation_unavailable ?? 0
}

// Fork 6d65165647: relayed Claude/Codex status is refused without attestation. Each captured
// relayed cancel below now asserts that refusal: the desktop records it, holds no row for the
// pane, and has no relayed turn for Ctrl+C inference to cancel.
async function expectRefused(server: AgentHookServer, atLeast: number): Promise<void> {
  await vi.waitFor(() => expect(rejections(server)).toBeGreaterThanOrEqual(atLeast))
  expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
  expect(
    server.inferInterrupt({
      paneKey: PANE,
      baselineUpdatedAt: 0,
      baselineStateStartedAt: 0,
      baselinePrompt: '',
      baselineAgentType: 'claude',
      intent: 'ctrl-c'
    })
  ).toBe(false)
}

describe('a relayed Claude cancel with a live subagent (captured)', () => {
  const records = loadCapture('claude-cancel-subagent-hooks')
  const upToCancel = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => hookAt(records, index))
  const subagentStop = (index: number): Record<string, unknown> => ({
    ...hookAt(records, index).payload,
    hook_event_name: 'SubagentStop',
    tool_name: undefined,
    tool_input: undefined
  })

  it("keeps the cancel through a child's permission prompt and its approval", async () => {
    const pane = await startSshPane(attestFixtureHookContext(new AgentHookServer()))
    await postCaptured(pane, upToCancel)
    await expectRefused(pane.desktop, 1)

    const childTool = hookAt(records, 6).payload
    await pane.post({ ...childTool, hook_event_name: 'PermissionRequest' })
    await pane.post(childTool)
    await expectRefused(pane.desktop, upToCancel.length + 2)
  })

  it("keeps the cancel while a child's permission card stays up over its next tool", async () => {
    const pane = await startSshPane(attestFixtureHookContext(new AgentHookServer()))
    await postCaptured(pane, upToCancel)
    await expectRefused(pane.desktop, 1)

    const childTool = hookAt(records, 6).payload
    await pane.post({ ...childTool, hook_event_name: 'PermissionRequest' })
    await pane.post({ ...childTool, tool_use_id: 'toolu_after_denial' })
    await pane.post(subagentStop(4))
    await expectRefused(pane.desktop, upToCancel.length + 3)
  })

  it("keeps the cancel when a restarted relay's first hook is the child's", async () => {
    const pane = await startSshPane(attestFixtureHookContext(new AgentHookServer()))
    await postCaptured(pane, upToCancel)
    await expectRefused(pane.desktop, 1)

    await restartRelay(pane)
    await pane.post(hookAt(records, 9).payload)
    await pane.post(subagentStop(4))
    await pane.post(subagentStop(9))
    await expectRefused(pane.desktop, upToCancel.length + 3)
  })

  it('releases the cancel on a replayed child hook whose prompt the desktop missed', async () => {
    const pane = await startSshPane(attestFixtureHookContext(new AgentHookServer()))
    await postCaptured(pane, upToCancel)
    const desktop = pane.desktop
    await expectRefused(desktop, 1)

    pane.desktop = attestFixtureHookContext(new AgentHookServer())
    running.push(pane.desktop)
    await pane.post(hookAt(records, 10).payload)
    await pane.post(hookAt(records, 9).payload)
    await expectRefused(pane.desktop, 1)
    pane.desktop = desktop
    const before = rejections(desktop)
    // The relay still replays what it accepted; the desktop refuses the replay too.
    expect(pane.relay.replayCachedPayloadsForPanes()).toBe(1)
    await expectRefused(desktop, before + 1)
  })

  it('does not read a restart-seeded local roster for a relayed pane', async () => {
    const userDataPath = temporaryDir('orca-relayed-cancel-restart-')
    const firstDesktop = attestFixtureHookContext(new AgentHookServer())
    await firstDesktop.start({ env: 'production', userDataPath })
    const pane = await startSshPane(firstDesktop)
    await postCaptured(
      pane,
      [0, 1, 2, 3, 4, 5].map((index) => hookAt(records, index))
    )
    await expectRefused(firstDesktop, 1)
    firstDesktop.flushStatusPersistSync()
    firstDesktop.stop()

    const desktop = attestFixtureHookContext(new AgentHookServer())
    await desktop.start({ env: 'production', userDataPath })
    pane.desktop = desktop
    running.push(desktop)
    // Nothing relayed was admitted, so the restart seeds no roster for the pane.
    expect(desktop._getStateForTests().claudeSubagentRosterByPaneKey.has(PANE)).toBe(false)

    await pane.post(subagentStop(4))
    await pane.post({
      hook_event_name: 'UserPromptSubmit',
      prompt: `<task-notification>\n<task-id>${String(hookAt(records, 4).payload.agent_id)}</task-id>\n<status>completed</status>`
    })
    await pane.post({ hook_event_name: 'Stop', background_tasks: [] })
    await pane.post(hookAt(records, 7).payload)
    await expectRefused(desktop, 4)
  })
})

describe('a relayed Claude cancel with a background shell (captured)', () => {
  const records = loadCapture('claude-cancel-shell-hooks')

  it('holds the cancel through a replay and releases it at the next prompt', async () => {
    const pane = await startSshPane(attestFixtureHookContext(new AgentHookServer()))
    await postCaptured(
      pane,
      [0, 1, 2, 3, 4, 5, 6].map((index) => hookAt(records, index))
    )
    await expectRefused(pane.desktop, 1)

    const before = rejections(pane.desktop)
    expect(pane.relay.replayCachedPayloadsForPanes()).toBe(1)
    await expectRefused(pane.desktop, before + 1)

    await pane.post(hookAt(records, 7).payload)
    await pane.post(hookAt(records, 8).payload)
    await expectRefused(pane.desktop, before + 3)
  })
})

it("keeps the cancel when a teammate's idle hook arrives after the late-hook window", async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_790_000_000_000)
  try {
    const pane = await startSshPane(attestFixtureHookContext(new AgentHookServer()))
    await pane.post({ hook_event_name: 'SessionStart', source: 'startup' })
    await pane.post({ hook_event_name: 'UserPromptSubmit', prompt: 'coordinate the team' })
    await pane.post({
      hook_event_name: 'SubagentStart',
      agent_id: 'areviewer-6d3cb5b52120b7bf',
      agent_type: 'reviewer'
    })
    await pane.post({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'sleep 45' },
      tool_use_id: 'toolu_1'
    })
    vi.setSystemTime(Date.now() + 2_000)
    await expectRefused(pane.desktop, 1)

    vi.setSystemTime(Date.now() + 20_000)
    const before = rejections(pane.desktop)
    await pane.post({ hook_event_name: 'TeammateIdle', teammate_name: 'reviewer' })
    await expectRefused(pane.desktop, before + 1)
  } finally {
    vi.useRealTimers()
  }
})

it('keeps a relayed waiting child visible when the main agent is cancelled', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  try {
    const server = attestFixtureHookContext(new AgentHookServer())
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        payload: {
          state: 'working',
          prompt: 'coordinate reviewers',
          agentType: 'claude',
          mainAgent: { state: 'working', stateStartedAt: 900 },
          subagents: [{ id: 'reviewer-1', state: 'waiting', startedAt: 900 }]
        }
      },
      'conn-1'
    )
    expect(rejections(server)).toBe(1)
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])

    vi.setSystemTime(1_500)
    expect(
      server.inferInterrupt({
        paneKey: PANE,
        baselineUpdatedAt: 1_000,
        baselineStateStartedAt: 1_000,
        baselinePrompt: 'coordinate reviewers',
        baselineAgentType: 'claude',
        intent: 'ctrl-c'
      })
    ).toBe(false)
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
  } finally {
    vi.useRealTimers()
  }
})
