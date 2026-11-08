import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { AtomicSnapshotWriter } from '../persistence/atomic-snapshot-writer'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from './server'
import { buildBody, postHookEvent, PANE } from './server.test-fixtures'
import { admitLegacyAgentStatus } from '../../shared/agent-hook-listener/listener-state'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../shared/agent-status/transport/agent-status-legacy-adapter'
import { wslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import { composeWorktreeId } from '../../shared/worktree/id'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const RESUMED = { key: 'session_id' as const, id: 'resumed-session' }

// Codex may stay silent until the resumed pane's first turn; seed identity at launch for every reader.
describe('a resume launch seeds the pane identity', () => {
  const servers: AgentHookServer[] = []
  let userDataPath: string

  beforeEach(() => {
    _internals.resetCachesForTests()
    getCohortAtEmitMock.mockReturnValue({})
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-launch-resume-identity-'))
  })

  afterEach(() => {
    for (const server of servers) {
      server.stop()
    }
    servers.length = 0
    rmSync(userDataPath, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  async function startServer(): Promise<AgentHookServer> {
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production', userDataPath })
    return server
  }

  it.each(['codex', 'claude'] as const)(
    'retains a %s hook replacement conversation through pane teardown and restart',
    async (agentType) => {
      const server = await startServer()
      server.recordLaunchResumeIdentity({
        paneKey: PANE,
        agentType,
        providerSession: RESUMED,
        launchedAt: 1
      })
      const response = await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'SessionStart',
          session_id: 'replacement-conversation',
          source: 'clear'
        }),
        `/hook/${agentType}`
      )
      expect(response.status).toBe(204)
      expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(
        'replacement-conversation'
      )
      server.clearPaneState(PANE)
      expect(server.flushResumeIdentityCheckpoint()).toBe(true)
      const saved = JSON.parse(readFileSync(server.lastStatusPath!, 'utf8'))
      expect(saved.entries[PANE]?.providerSession?.id).toBe('replacement-conversation')
      server.stop()
      servers.length = 0
      const restarted = await startServer()
      expect(restarted.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(
        'replacement-conversation'
      )
    }
  )

  it('retains a replacement hook from the launch workspace WSL relay', async () => {
    const server = await startServer()
    const worktreeId = composeWorktreeId('repo-wsl', '\\\\wsl.localhost\\Ubuntu\\work\\repo')
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      worktreeId,
      agentType: 'claude',
      providerSession: RESUMED,
      launchedAt: 1
    })
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId,
        source: 'claude',
        hookEventName: 'SessionStart',
        providerSession: { key: 'session_id', id: 'wsl-replacement' },
        payload: { state: 'working', prompt: '', agentType: 'claude' }
      },
      wslHookRelayConnectionId('Ubuntu')
    )
    expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe('wsl-replacement')
    server.clearPaneState(PANE)
    expect(server.flushResumeIdentityCheckpoint()).toBe(true)
    const saved = JSON.parse(readFileSync(server.lastStatusPath!, 'utf8'))
    expect(saved.entries[PANE]?.providerSession?.id).toBe('wsl-replacement')
  })

  it('does not lend an ended resume checkpoint to a newly started conversation', async () => {
    const server = await startServer()
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'codex',
      providerSession: RESUMED,
      launchedAt: 1
    })
    await postHookEvent(
      server,
      buildBody({ hook_event_name: 'SessionStart', session_id: RESUMED.id }),
      '/hook/codex'
    )
    server.reconcileEndedProcessForPaneKeys([PANE], {
      preserveResumeIdentity: true,
      endedPresence: { agent: 'codex', session: RESUMED.id, ended: true }
    })
    const response = await postHookEvent(
      server,
      buildBody({ hook_event_name: 'SessionStart', session_id: 'fresh-conversation' }),
      '/hook/codex'
    )
    expect(response.status).toBe(204)
    expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe('fresh-conversation')
    server.clearPaneState(PANE)
    expect(server.flushResumeIdentityCheckpoint()).toBe(true)
    const saved = JSON.parse(readFileSync(server.lastStatusPath!, 'utf8'))
    expect(saved.entries[PANE]).toBeUndefined()
  })

  it('commits resume identity synchronously and reports a failed disk checkpoint without dropping it', async () => {
    const server = await startServer()
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      worktreeId: 'wt-1',
      agentType: 'codex',
      providerSession: RESUMED,
      launchedAt: 1
    })
    expect(server.flushResumeIdentityCheckpoint()).toBe(true)
    const saved = JSON.parse(readFileSync(server.lastStatusPath!, 'utf8'))
    expect(saved.entries[PANE].providerSession.id).toBe('resumed-session')
    vi.spyOn(AtomicSnapshotWriter.prototype, 'writeSync').mockImplementation(() => {
      throw new Error('synthetic disk checkpoint failure')
    })
    expect(server.flushResumeIdentityCheckpoint()).toBe(false)
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([
      expect.objectContaining({ providerSession: RESUMED })
    ])
  })

  it('publishes an identity-only row before the agent reports', async () => {
    const server = await startServer()
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      worktreeId: 'wt-1',
      agentType: 'codex',
      providerSession: RESUMED,
      launchedAt: Date.now()
    })
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([
      expect.objectContaining({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        agentType: 'codex',
        providerSession: RESUMED,
        providerSessionOnly: true
      })
    ])
  })

  it('yields to a newer agent report', async () => {
    const server = await startServer()
    const launchedAt = Date.now() - 1_000
    const response = await postHookEvent(
      server,
      buildBody({ hook_event_name: 'SessionStart', session_id: 'agent-reported' }),
      '/hook/codex'
    )
    expect(response.status).toBe(204)
    const outcome = server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'codex',
      providerSession: RESUMED,
      launchedAt
    })
    expect(outcome).toBe('refused')
    expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe('agent-reported')
  })

  it("replaces a row left by the pane's previous process", async () => {
    const server = await startServer()
    const response = await postHookEvent(
      server,
      buildBody({ hook_event_name: 'Stop', session_id: 'previous-run' }),
      '/hook/codex'
    )
    expect(response.status).toBe(204)
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'codex',
      providerSession: RESUMED,
      launchedAt: Date.now() + 1_000
    })
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      providerSession: RESUMED,
      providerSessionOnly: true
    })

    await postHookEvent(
      server,
      buildBody({ hook_event_name: 'UserPromptSubmit', session_id: RESUMED.id, prompt: 'go on' }),
      '/hook/codex'
    )
    const [row] = server.getStatusSnapshotForPane(PANE)
    expect(row?.providerSessionOnly).toBeUndefined()
    expect(row).toMatchObject({ state: 'working', providerSession: RESUMED })
  })

  it('keeps the seeded identity when terminal evidence starts the first turn', async () => {
    const server = await startServer()
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'opencode2',
      providerSession: RESUMED,
      launchedAt: Date.now()
    })
    server.ingestTerminalStatus({
      paneKey: PANE,
      origin: 'process',
      payload: { state: 'working', prompt: '', agentType: 'opencode2' }
    })
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      providerSession: RESUMED
    })
    server.reconcileEndedProcessForPaneKeys([PANE], {
      preserveResumeIdentity: true,
      endedPresence: { agent: 'opencode2', session: RESUMED.id, ended: true }
    })
    expect(
      server.recordLaunchResumeIdentity({
        paneKey: PANE,
        agentType: 'opencode2',
        providerSession: RESUMED,
        launchedAt: 1
      })
    ).toBe('seeded')
    server.ingestTerminalStatus({
      paneKey: PANE,
      origin: 'process',
      payload: { state: 'working', prompt: '', agentType: 'opencode2' }
    })
    const [resumed] = server.getStatusSnapshotForPane(PANE)
    expect(resumed).toMatchObject({ state: 'working', providerSession: RESUMED })
    expect(resumed?.providerSessionOnly).toBeUndefined()
    server.reconcileEndedProcessForPaneKeys([PANE], {
      preserveResumeIdentity: true,
      endedPresence: { agent: 'opencode2', session: RESUMED.id, ended: true }
    })
    server.ingestTerminalStatus({
      paneKey: PANE,
      origin: 'process',
      payload: { state: 'working', prompt: '', agentType: 'opencode2' }
    })
    expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession).toBeUndefined()
  })

  it('keeps the seeded identity across a host restart', async () => {
    const server = await startServer()
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      worktreeId: 'wt-1',
      agentType: 'codex',
      providerSession: RESUMED,
      launchedAt: Date.now()
    })
    server.ingestTerminalStatus({
      paneKey: PANE,
      origin: 'process',
      payload: { state: 'working', prompt: '', agentType: 'codex' }
    })
    server.reconcileEndedProcessForPaneKeys([PANE], {
      preserveResumeIdentity: true,
      endedPresence: { agent: 'codex', session: RESUMED.id, ended: true }
    })
    server.stop()
    servers.length = 0
    const restarted = await startServer()
    expect(restarted.getStatusSnapshotForPane(PANE)).toEqual([
      expect.objectContaining({
        agentType: 'codex',
        providerSession: RESUMED,
        providerSessionOnly: true
      })
    ])
    expect(
      restarted.recordLaunchResumeIdentity({
        paneKey: PANE,
        worktreeId: 'wt-1',
        agentType: 'codex',
        providerSession: RESUMED,
        launchedAt: 1
      })
    ).toBe('seeded')
    restarted.ingestTerminalStatus({
      paneKey: PANE,
      origin: 'process',
      payload: { state: 'working', prompt: '', agentType: 'codex' }
    })
    expect(restarted.getStatusSnapshotForPane(PANE)[0]?.providerSession).toEqual(RESUMED)
    restarted.clearPaneState(PANE)
    restarted.ingestTerminalStatus({
      paneKey: PANE,
      origin: 'process',
      payload: { state: 'working', prompt: '', agentType: 'codex' }
    })
    expect(restarted.getStatusSnapshotForPane(PANE)[0]?.providerSession).toBeUndefined()
  })

  it.each([undefined, 'process'] as const)(
    'retains a silent resume through cleanup and restart without lending its ID to %s',
    async (origin) => {
      const server = await startServer()
      server.recordLaunchResumeIdentity({
        paneKey: PANE,
        worktreeId: 'wt-1',
        agentType: 'codex',
        providerSession: RESUMED,
        launchedAt: 1
      })
      server.clearPaneState(PANE, { forgetAgentExit: true })
      expect(server.flushResumeIdentityCheckpoint()).toBe(true)
      const saved = JSON.parse(readFileSync(server.lastStatusPath!, 'utf8'))
      expect(saved.entries[PANE]?.providerSession).toEqual(RESUMED)
      expect(saved.entries[PANE]?.runtimeResumePendingObservation).toBeUndefined()
      server.stop()
      servers.length = 0
      const restarted = await startServer()
      expect(restarted.getStatusSnapshotForPane(PANE)[0]?.providerSession).toEqual(RESUMED)
      restarted.ingestTerminalStatus({
        paneKey: PANE,
        origin,
        payload: { state: 'working', prompt: '', agentType: 'codex' }
      })
      expect(restarted.getStatusSnapshotForPane(PANE)[0]?.providerSession).toBeUndefined()
    }
  )

  it('checkpoints the same identity when its first hook wins the launch race', async () => {
    const server = await startServer()
    const response = await postHookEvent(
      server,
      buildBody({ hook_event_name: 'SessionStart', session_id: RESUMED.id }),
      '/hook/codex'
    )
    expect(response.status).toBe(204)
    expect(
      server.recordLaunchResumeIdentity({
        paneKey: PANE,
        agentType: 'codex',
        providerSession: RESUMED,
        launchedAt: 1
      })
    ).toBe('deduped')
    server.clearPaneState(PANE)
    expect(server.flushResumeIdentityCheckpoint()).toBe(true)
    const saved = JSON.parse(readFileSync(server.lastStatusPath!, 'utf8'))
    expect(saved.entries[PANE]?.providerSession).toEqual(RESUMED)
    expect(saved.entries[PANE]?.runtimeResumePendingObservation).toBeUndefined()
  })

  it('retains a lost connection checkpoint without revisiting the reinserted map row', async () => {
    const server = await startServer()
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'codex',
      providerSession: RESUMED,
      launchedAt: 1
    })
    const state = server['state']
    const row = state.lastStatusByPaneKey.get(PANE)
    if (!row) {
      throw new Error('Missing synthetic seed')
    }
    admitLegacyAgentStatus(
      state,
      'main-status-cleanup',
      { ...row, connectionId: 'synthetic-remote' },
      AGENT_STATUS_2A_CURRENT_PRODUCER_MODE
    )
    server.clearStatusEntriesForConnection('synthetic-remote')
    server.clearStatusEntriesForConnection('synthetic-remote')
    expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession).toEqual(RESUMED)
  })

  it('does not retain an explicit resume after its tab is closed', async () => {
    const server = await startServer()
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'codex',
      providerSession: RESUMED,
      launchedAt: 1
    })
    server.dropStatusEntriesByTabPrefix('tab-1')
    server.clearPaneState(PANE)
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
  })

  it('ignores a pane key that is not a stable tab:leaf key', async () => {
    const server = await startServer()
    server.recordLaunchResumeIdentity({
      paneKey: 'not-a-pane',
      agentType: 'codex',
      providerSession: RESUMED,
      launchedAt: Date.now()
    })
    expect(server.getStatusSnapshot()).toEqual([])
  })
})
