import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, PANE } from '../server.test-fixtures'
import { readSavedStatus } from '../persistence/last-status.test-fixtures'
import {
  createAdmittedResumeHost,
  postAdmittedFixtureHook
} from '../../../admitted-resume-host.test-fixtures'
import { admitLegacyAgentStatus } from '../../../../../shared/agent-hook-listener/listener-state'
import { AGENT_STATUS_2A_CURRENT_PRODUCER_MODE } from '../../../../../shared/agent-status/transport/agent-status-legacy-adapter'
import { wslHookRelayConnectionId } from '../../../../../shared/wsl-hook-relay-contract'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../../../../telemetry/client', () => ({ track: trackMock }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

// Upstream seeds Claude/Codex resume IDs as active rows at launch. This fork keeps a Claude/Codex
// launch request as an unverified recipe until an admitted hook from the owned PTY proves it, so each
// upstream scenario below asserts its intent (no lost conversation, no lent ID) under that contract.
const ORIGINAL = 'original-conversation'
const RESUMED = { key: 'session_id' as const, id: 'resumed-session' }
type Agent = 'claude' | 'codex'

describe('a resume launch keeps the pane identity without lending it', () => {
  const servers: AgentHookServer[] = []
  let root: string
  let host: Awaited<ReturnType<typeof createAdmittedResumeHost>> | undefined

  beforeEach(() => {
    _internals.resetCachesForTests()
    getCohortAtEmitMock.mockReturnValue({})
    root = mkdtempSync(join(tmpdir(), 'orca-launch-resume-identity-'))
  })

  afterEach(async () => {
    const owned = host
    host = undefined
    vi.restoreAllMocks()
    for (const server of servers) {
      await server.flushProviderObservations()
      server.stop()
    }
    servers.length = 0
    await owned?.dispose()
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith('orca-launch-resume-identity-')
    ) {
      throw new Error('Refusing cleanup outside own launch identity fixture')
    }
    rmSync(root, { recursive: true, force: true })
  })

  async function startPlain(): Promise<AgentHookServer> {
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production', userDataPath: root })
    return server
  }

  async function start(agent: Agent): Promise<AgentHookServer> {
    host ??= await createAdmittedResumeHost(root, agent)
    const owned = host
    const server = await startPlain()
    server.setHookContextSnapshotReader(owned.read)
    server.setProviderObservationWriter(owned.write)
    server.setHookRootEvidenceReader(async () => ({
      verdict: 'root',
      binding: owned.incarnationId
    }))
    return server
  }

  async function restart(server: AgentHookServer, agent: Agent): Promise<AgentHookServer> {
    await server.flushProviderObservations()
    server.stop()
    servers.splice(servers.indexOf(server), 1)
    return start(agent)
  }

  function request(server: AgentHookServer, agent: Agent, id = ORIGINAL) {
    return server.recordLaunchResumeIdentity({
      paneKey: PANE,
      worktreeId: host?.worktreeId,
      agentType: agent,
      providerSession: { key: 'session_id', id },
      launchedAt: 100
    })
  }

  async function hook(
    server: AgentHookServer,
    agent: Agent,
    id: string,
    source = 'resume',
    hookEventName = 'SessionStart',
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    const status = await postAdmittedFixtureHook(
      server,
      buildBody(
        { hook_event_name: hookEventName, session_id: id, cwd: host?.cwd, source, ...extra },
        {
          worktreeId: host?.worktreeId,
          launchToken: 'abc',
          agentProcess: JSON.stringify({ pid: 1001, platform: 'linux', startTime: 'synthetic-start' })
        }
      ),
      `/hook/${agent}`
    )
    expect(status).toBe(204)
    expect(await server.flushProviderObservations()).toBe(true)
  }

  const activeId = (server: AgentHookServer) =>
    server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id
  const savedEntry = (server: AgentHookServer) =>
    JSON.parse(readSavedStatus(server.lastStatusPath!)).entries[PANE]
  const recipeIds = (server: AgentHookServer) =>
    server
      .getUnverifiedResumeLaunchRecipesForPane(PANE, host?.worktreeId)
      .recipes.map((recipe) => recipe.providerSession.id)
  const rejections = (server: AgentHookServer, reason: string) =>
    (server.getContextIntegrityRejections() as Record<string, number>)[reason] ?? 0

  it('retains an admitted claude clear replacement through pane teardown and restart', async () => {
    const server = await start('claude')
    expect(request(server, 'claude')).toBe('recorded')
    await hook(server, 'claude', ORIGINAL)
    await hook(server, 'claude', 'replacement-conversation', 'clear')
    expect(activeId(server)).toBe('replacement-conversation')
    server.clearPaneState(PANE)
    expect(server.flushResumeIdentityCheckpoint()).toBe(true)
    expect(savedEntry(server)?.providerSession?.id).toBe('replacement-conversation')
    const restarted = await restart(server, 'claude')
    expect(activeId(restarted)).toBe('replacement-conversation')
  })

  // Codex has no verified in-process transition contract yet; the proven original stays the checkpoint.
  it('keeps the admitted codex original when an in-process clear is unconfirmed', async () => {
    const server = await start('codex')
    expect(request(server, 'codex')).toBe('recorded')
    await hook(server, 'codex', ORIGINAL)
    const before = rejections(server, 'resume_provider_transition_unconfirmed')
    await hook(server, 'codex', 'replacement-conversation', 'clear')
    expect(rejections(server, 'resume_provider_transition_unconfirmed')).toBe(before + 1)
    expect(activeId(server)).toBe(ORIGINAL)
    server.clearPaneState(PANE)
    expect(server.flushResumeIdentityCheckpoint()).toBe(true)
    expect(savedEntry(server)?.providerSession?.id).toBe(ORIGINAL)
  })

  // WSL relay admission evidence is not implemented; an unattested relay must not retarget the pane.
  it('refuses an unattested replacement from a WSL relay and keeps the requested recipe', async () => {
    const server = await start('claude')
    expect(request(server, 'claude')).toBe('recorded')
    const before = rejections(server, 'remote_context_attestation_unavailable')
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: host!.worktreeId,
        source: 'claude',
        hookEventName: 'SessionStart',
        providerSession: { key: 'session_id', id: 'wsl-replacement' },
        payload: { state: 'working', prompt: '', agentType: 'claude' }
      },
      wslHookRelayConnectionId('Ubuntu')
    )
    expect(rejections(server, 'remote_context_attestation_unavailable')).toBe(before + 1)
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
    expect(recipeIds(server)).toEqual([ORIGINAL])
  })

  it('does not lend an ended resume checkpoint to an unproven new conversation', async () => {
    const server = await start('codex')
    expect(request(server, 'codex')).toBe('recorded')
    await hook(server, 'codex', ORIGINAL)
    server.reconcileEndedProcessForPaneKeys([PANE], {
      preserveResumeIdentity: true,
      endedPresence: { agent: 'codex', session: ORIGINAL, ended: true }
    })
    await hook(server, 'codex', 'fresh-conversation', 'startup')
    expect(activeId(server)).toBe(ORIGINAL)
    server.clearPaneState(PANE)
    expect(server.flushResumeIdentityCheckpoint()).toBe(true)
    expect(savedEntry(server)?.providerSession?.id).toBe(ORIGINAL)
    expect(readSavedStatus(server.lastStatusPath!)).not.toContain('fresh-conversation')
  })

  it('commits a quiet resume request durably as an unverified recipe only', async () => {
    const server = await start('codex')
    expect(request(server, 'codex')).toBe('recorded')
    expect(server.flushResumeIdentityCheckpoint()).toBe(true)
    expect(savedEntry(server)).toBeUndefined()
    const restarted = await restart(server, 'codex')
    expect(restarted.getStatusSnapshotForPane(PANE)).toEqual([])
    expect(recipeIds(restarted)).toEqual([ORIGINAL])
  })

  it('publishes no active row before the agent proves the requested identity', async () => {
    const server = await start('codex')
    expect(request(server, 'codex')).toBe('recorded')
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
    expect(rejections(server, 'launch_context_attestation_unavailable')).toBe(1)
    expect(recipeIds(server)).toEqual([ORIGINAL])
  })

  it('keeps a newer admitted report when a different launch request arrives later', async () => {
    const server = await start('codex')
    await hook(server, 'codex', ORIGINAL)
    expect(request(server, 'codex', 'other-conversation')).toBe('recorded')
    expect(activeId(server)).toBe(ORIGINAL)
    expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSessionOnly).toBeUndefined()
    expect(recipeIds(server)).toEqual(['other-conversation'])
  })

  it("refuses a previous process's mismatched report and admits the requested conversation", async () => {
    const server = await start('codex')
    const before = rejections(server, 'resume_provider_id_mismatch')
    await hook(server, 'codex', 'previous-run', 'resume', 'Stop')
    expect(rejections(server, 'resume_provider_id_mismatch')).toBe(before + 1)
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
    expect(request(server, 'codex')).toBe('recorded')
    await hook(server, 'codex', ORIGINAL, 'resume', 'UserPromptSubmit', { prompt: 'go on' })
    const [row] = server.getStatusSnapshotForPane(PANE)
    expect(row?.providerSessionOnly).toBeUndefined()
    expect(row).toMatchObject({ state: 'working', providerSession: { id: ORIGINAL } })
  })

  it('keeps the seeded identity when terminal evidence starts the first turn', async () => {
    const server = await startPlain()
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

  it('refuses codex terminal evidence and keeps the quiet recipe across a host restart', async () => {
    const server = await start('codex')
    expect(request(server, 'codex')).toBe('recorded')
    const before = rejections(server, 'terminal_context_attestation_unavailable')
    server.ingestTerminalStatus({
      paneKey: PANE,
      origin: 'process',
      payload: { state: 'working', prompt: '', agentType: 'codex' }
    })
    expect(rejections(server, 'terminal_context_attestation_unavailable')).toBe(before + 1)
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
    const restarted = await restart(server, 'codex')
    expect(restarted.getStatusSnapshotForPane(PANE)).toEqual([])
    expect(recipeIds(restarted)).toEqual([ORIGINAL])
  })

  it.each([undefined, 'process'] as const)(
    'retains a silent resume through cleanup and restart without lending its ID to %s',
    async (origin) => {
      const server = await start('codex')
      expect(request(server, 'codex')).toBe('recorded')
      server.clearPaneState(PANE, { forgetAgentExit: true })
      expect(server.flushResumeIdentityCheckpoint()).toBe(true)
      const restarted = await restart(server, 'codex')
      expect(recipeIds(restarted)).toEqual([ORIGINAL])
      restarted.ingestTerminalStatus({
        paneKey: PANE,
        origin,
        payload: { state: 'working', prompt: '', agentType: 'codex' }
      })
      expect(restarted.getStatusSnapshotForPane(PANE)[0]?.providerSession).toBeUndefined()
      expect(recipeIds(restarted)).toEqual([ORIGINAL])
    }
  )

  it('checkpoints the same identity when its first admitted hook wins the launch race', async () => {
    const server = await start('codex')
    await hook(server, 'codex', ORIGINAL)
    expect(request(server, 'codex')).toBe('recorded')
    server.clearPaneState(PANE)
    expect(server.flushResumeIdentityCheckpoint()).toBe(true)
    expect(savedEntry(server)).toMatchObject({
      providerSession: { id: ORIGINAL },
      runtimeResumeCheckpoint: true
    })
    expect(savedEntry(server)?.runtimeResumePendingObservation).toBeUndefined()
  })

  it('retains a lost connection checkpoint without revisiting the reinserted map row', async () => {
    const server = await startPlain()
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      agentType: 'opencode2',
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
    const server = await start('codex')
    expect(request(server, 'codex')).toBe('recorded')
    server.dropStatusEntriesByTabPrefix('tab-1')
    server.clearPaneState(PANE)
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
  })
})
