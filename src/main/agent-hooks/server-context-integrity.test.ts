import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server/agent-hook-server'
import { buildBody, postHookEvent, PANE, GOOD_PANE } from './server/testing/server.test-fixtures'
import type { HookContextSnapshot } from './server/hook-context-snapshot'
import type { SpoolRecord } from '../../shared/agent-hook-listener/transport/agent-hook-spool'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status/contracts/agent-status-subject'
import { setPluginHookRunner } from '../plugins/hooks/plugin-hook-dispatch'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readSavedStatus } from './server/testing/persistence/last-status.test-fixtures'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type * as AgentPresenceProbe from '../../shared/agent-status/process/agent-process-presence-probe'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock(
  '../../shared/agent-status/process/agent-process-presence-probe',
  async (importOriginal) => ({
    ...(await importOriginal<typeof AgentPresenceProbe>()),
    probeAgentProcessPresence: vi.fn(async () => 'live')
  })
)

class ContextTestServer extends AgentHookServer {
  admitTransportPeer(incoming: unknown) {
    return this.admitLocalHookContext('claude', incoming, {
      pid: 2002,
      creationTimeKey: '133444736000000000',
      isCurrent: () => true
    })
  }

  replay(record: SpoolRecord) {
    return this.ingestSpoolRecord(record)
  }
  teardownPane() {
    this.clearPaneState(PANE)
  }
}

const NOW = 1800000000000

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
})

const servers: ContextTestServer[] = []
const roots: string[] = []
const sessionId = '00000000-0000-4000-8000-000000000001'
const processIdentity = JSON.stringify({
  pid: 1001,
  platform: 'linux',
  startTime: 'synthetic-start'
})
const snapshot: HookContextSnapshot = {
  executionHostId: 'local',
  paneKey: PANE,
  worktreeId: 'wt-1',
  ptyId: 'pty-b',
  incarnationId: 'generation-b',
  launchTokenHash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  cwd: '/workspace-b',
  reportedCwd: '/workspace-b'
}

async function serverWithContext() {
  const server = new ContextTestServer()
  servers.push(server)
  await server.start({ env: 'production' })
  configureContext(server)
  return server
}

function configureContext(server: ContextTestServer) {
  server.setHookContextSnapshotReader(async (envelope) => ({
    ...snapshot,
    reportedCwd:
      typeof envelope.hookPayloadRecord.cwd === 'string' ? envelope.hookPayloadRecord.cwd : ''
  }))
  server.setHookRootEvidenceReader(async () => ({ verdict: 'root', binding: 'generation-b' }))
}

function body(cwd = '/workspace-b') {
  return buildBody(
    { hook_event_name: 'SessionStart', source: 'startup', session_id: sessionId, cwd },
    { agentProcess: processIdentity, launchToken: 'abc' }
  )
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  setPluginHookRunner(null)
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith('orca-context-integrity-')
    ) {
      throw new Error('Refusing cleanup outside owned context fixture')
    }
    rmSync(root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

async function historicalServer(resumeInPane = false) {
  const root = mkdtempSync(join(tmpdir(), 'orca-context-integrity-'))
  roots.push(root)
  const directory = join(root, 'agent-hooks')
  mkdirSync(directory)
  writeFileSync(
    join(directory, 'last-status.json'),
    JSON.stringify({
      version: 2,
      entries: {
        [resumeInPane ? PANE : GOOD_PANE]: {
          paneKey: resumeInPane ? PANE : GOOD_PANE,
          tabId: resumeInPane ? 'tab-1' : 'tab-good',
          worktreeId: resumeInPane ? 'wt-1' : 'wt-other',
          ...(resumeInPane ? { runtimeResumeCheckpoint: true } : {}),
          connectionId: null,
          providerSessionOnly: true,
          retainedForLiveness: true,
          receivedAt: NOW - 1000,
          stateStartedAt: NOW - 1000,
          providerSession: { key: 'session_id', id: sessionId },
          payload: { state: 'done', prompt: '', agentType: 'claude' }
        }
      }
    })
  )
  const server = new ContextTestServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath: root })
  return server
}

describe('hook context integrity before attributed state', () => {
  it('requires an observed provider process when transport evidence replaces a missing body process', async () => {
    const server = await serverWithContext()
    const incoming = body()
    delete incoming.agentProcess
    expect(await server.admitTransportPeer(incoming)).toBe(false)
    expect(server.getContextIntegrityRejections()).toHaveProperty(
      'process_generation_unconfirmed',
      1
    )
    server.setHookRootEvidenceReader(async () => ({
      verdict: 'root',
      binding: 'generation-b',
      process: { pid: 3003, platform: 'win32', startTime: 'win32:1700000000000' }
    }))
    const admitted = await server.admitTransportPeer(incoming)
    if (!admitted || admitted === true) {
      throw new Error('Expected context backed by the observed provider process')
    }
    expect(admitted.envelope.record.agentProcess).toEqual({
      pid: 3003,
      platform: 'win32',
      startTime: 'win32:1700000000000'
    })
    admitted.release()
  })

  it.each([false, true])(
    'preserves only the admitted replacement through teardown (wrong CWD: %s)',
    async (wrongCwd) => {
      const server = await historicalServer(true)
      configureContext(server)
      await postHookEvent(server, body())
      const incoming = body(wrongCwd ? '/workspace-a' : '/workspace-b')
      const replacement = '00000000-0000-4000-8000-000000000003'
      incoming.payload = { ...incoming.payload, source: 'clear', session_id: replacement }
      await postHookEvent(server, incoming)
      const expected = wrongCwd ? sessionId : replacement
      expect(server.getProviderSessionIdentities()).toEqual([
        expect.objectContaining({ paneKey: PANE, worktreeId: 'wt-1', sessionId: expected })
      ])
      server.teardownPane()
      expect(server.flushResumeIdentityCheckpoint()).toBe(true)
      const root = roots.at(-1)
      if (!root) {
        throw new Error('Missing owned persistence fixture')
      }
      const saved = JSON.parse(readSavedStatus(join(root, 'agent-hooks', 'last-status.json')))
      expect(saved.entries[PANE]?.providerSession?.id).toBe(expected)
    }
  )

  it('refuses an unconfigured listener instead of silently entering legacy attribution', async () => {
    const server = new ContextTestServer()
    servers.push(server)
    await server.start({ env: 'production' })
    await postHookEvent(server, body())
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getContextIntegrityRejections()).toHaveProperty('context_reader_unavailable', 1)
  })
  it('accepts matching host/pane/workspace/CWD and host-proven process generation', async () => {
    const server = await serverWithContext()
    await postHookEvent(server, body())
    expect(server.getContextIntegrityRejections()).toEqual({})
    expect(server.getProviderSessionIdentities()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          paneKey: PANE,
          worktreeId: 'wt-1',
          sessionId
        })
      ])
    )
  })

  it('refuses a different-CWD association before relying on launch-path defaults', async () => {
    const server = await serverWithContext()
    await postHookEvent(server, body('/workspace-a'))
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getContextIntegrityRejections()).toHaveProperty('workspace_cwd_unconfirmed', 1)
  })

  it.each(['workspace', 'pane', 'host', 'generation', 'unknown-root', 'missing-process'])(
    'refuses injected or unproven identity: %s',
    async (dimension) => {
      const server = await serverWithContext()
      const incoming: ReturnType<typeof body> & { executionHostId?: string } = body()
      if (dimension === 'workspace') {
        incoming.worktreeId = 'wt-other'
      }
      if (dimension === 'pane') {
        incoming.paneKey = GOOD_PANE
        incoming.tabId = 'tab-good'
      }
      if (dimension === 'host') {
        incoming.executionHostId = 'ssh:foreign'
      }
      if (dimension === 'generation') {
        server.setHookRootEvidenceReader(async () => ({
          verdict: 'root',
          binding: 'old-generation'
        }))
      }
      if (dimension === 'unknown-root') {
        server.setHookRootEvidenceReader(async () => ({ verdict: 'unknown' }))
      }
      if (dimension === 'missing-process') {
        delete incoming.agentProcess
      }
      await postHookEvent(server, incoming)
      expect(server.getStatusSnapshot()).toEqual([])
      expect(Object.keys(server.getContextIntegrityRejections())).toHaveLength(1)
    }
  )

  it('refuses an owner replacement during the asynchronous proof', async () => {
    const server = await serverWithContext()
    let reads = 0
    server.setHookContextSnapshotReader(async () =>
      ++reads === 1
        ? snapshot
        : { ...snapshot, ptyId: 'replacement', incarnationId: 'replacement-generation' }
    )
    await postHookEvent(server, body())
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getContextIntegrityRejections()).toHaveProperty(
      'context_changed_during_verification',
      1
    )
  })

  it('does not resurrect a working row when the agent exits during verification', async () => {
    const server = await serverWithContext()
    await postHookEvent(server, body())
    const original = server.getProviderSessionIdentities()
    server.setHookRootEvidenceReader(async () => {
      server.reconcileEndedProcessForPaneKeys([PANE], {
        preserveResumeIdentity: true,
        endedPresence: {
          agent: 'claude',
          ended: true,
          process: { pid: 1001, platform: 'linux', startTime: 'synthetic-start' }
        }
      })
      return { verdict: 'root', binding: 'generation-b' }
    })
    await postHookEvent(server, body())
    expect(server.getContextIntegrityRejections()).toHaveProperty(
      'agent_exited_during_context_verification',
      1
    )
    expect(server.getStatusSnapshot().every((row) => row.state !== 'working')).toBe(true)
    expect(server.getProviderSessionIdentities()).toEqual(original)
  })

  it('keeps an existing identity while refusing a new launch-only adoption', async () => {
    const server = await historicalServer()
    const seed = {
      paneKey: GOOD_PANE,
      worktreeId: 'wt-other',
      agentType: 'claude',
      providerSession: { key: 'session_id' as const, id: sessionId },
      launchedAt: NOW
    }
    const original = server.getProviderSessionIdentities()
    server.setHookContextSnapshotReader(async () => snapshot)
    expect(server.recordLaunchResumeIdentity({ ...seed, paneKey: PANE, worktreeId: 'wt-1' })).toBe(
      'recorded'
    )
    expect(server.getContextIntegrityRejections()).toHaveProperty(
      'launch_context_attestation_unavailable',
      1
    )
    expect(server.getProviderSessionIdentities()).toEqual(original)
  })

  it('preserves the original owner when the same provider ID is claimed by another pane', async () => {
    const server = await historicalServer()
    const original = server.getProviderSessionIdentities()
    server.setHookContextSnapshotReader(async () => snapshot)
    server.setHookRootEvidenceReader(async () => ({ verdict: 'root', binding: 'generation-b' }))
    await postHookEvent(server, body())
    expect(server.getContextIntegrityRejections()).toHaveProperty(
      'provider_owned_by_another_pane',
      1
    )
    expect(server.getProviderSessionIdentities()).toEqual(original)
  })

  it('checks canonical ownership again after the final asynchronous inventory read', async () => {
    const server = await serverWithContext()
    let reads = 0
    server.setHookContextSnapshotReader(async () => {
      if (++reads === 2) {
        const structuredId = '00000000-0000-4000-8000-000000000002'
        server.ingestStructuredStatus(
          {
            sessionId: structuredId,
            workspaceId: 'wt-other',
            agent: 'claude',
            status: 'idle',
            latestPrompt: '',
            updatedAt: NOW,
            providerSession: { key: 'session_id', id: sessionId }
          },
          makeStructuredAgentStatusSubject(
            {
              executionHostId: 'local',
              wslDistro: null,
              workspaceId: 'wt-other',
              workspaceKind: 'git-worktree'
            },
            structuredId
          )
        )
      }
      return snapshot
    })
    await postHookEvent(server, body())
    expect(server.getContextIntegrityRejections()).toHaveProperty(
      'provider_owned_by_another_pane',
      1
    )
    const identities = server.getProviderSessionIdentities()
    expect(identities).toHaveLength(1)
    expect(identities[0]).toMatchObject({ worktreeId: 'wt-other', sessionId })
  })

  it('serializes HTTP and spool claims until the first ownership mutation is committed', async () => {
    const server = await serverWithContext()
    let releaseProof!: () => void
    let proofStarted!: () => void
    const started = new Promise<void>((resolve) => {
      proofStarted = resolve
    })
    const proof = new Promise<void>((resolve) => {
      releaseProof = resolve
    })
    let proofs = 0
    server.setHookRootEvidenceReader(async () => {
      if (++proofs === 1) {
        proofStarted()
        await proof
      }
      return { verdict: 'root', binding: 'generation-b' }
    })
    server.setHookContextSnapshotReader(async (envelope) => ({
      ...snapshot,
      paneKey: envelope.paneKey,
      worktreeId: envelope.worktreeId ?? ''
    }))
    const first = postHookEvent(server, body())
    await started
    const second = server.replay({
      paneKey: GOOD_PANE,
      tabId: 'tab-good',
      worktreeId: 'wt-other',
      env: 'production',
      source: 'claude',
      receivedAt: NOW,
      agentProcess: processIdentity,
      launchToken: 'abc',
      payload: body().payload
    })
    releaseProof()
    await Promise.all([first, second])
    expect(server.getProviderSessionIdentities()).toEqual([
      expect.objectContaining({ paneKey: PANE, worktreeId: 'wt-1', sessionId })
    ])
    expect(server.getContextIntegrityRejections()).toHaveProperty(
      'provider_owned_by_another_pane',
      1
    )
  })

  it('releases admission after an unresponsive reader without applying its late result', async () => {
    const server = await serverWithContext()
    let finish!: (snapshot: HookContextSnapshot) => void
    server.setHookContextSnapshotReader(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    await postHookEvent(server, body())
    expect(server.getProviderSessionIdentities()).toEqual([])
    expect(server.getContextIntegrityRejections()).toHaveProperty('context_evidence_unavailable', 1)
    server.setHookContextSnapshotReader(async () => snapshot)
    await postHookEvent(server, body())
    finish({ ...snapshot, paneKey: GOOD_PANE, worktreeId: 'wt-other' })
    expect(server.getProviderSessionIdentities()).toEqual([
      expect.objectContaining({ paneKey: PANE, sessionId })
    ])
  })

  it('does not carry in-flight admission into a restarted listener generation', async () => {
    const server = await serverWithContext()
    let entered!: () => void
    let finish!: (snapshot: HookContextSnapshot) => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    server.setHookContextSnapshotReader(
      () =>
        new Promise((resolve) => {
          entered()
          finish = resolve
        })
    )
    const old = postHookEvent(server, body())
    await started
    server.stop()
    await server.start({ env: 'production' })
    server.setHookContextSnapshotReader(async () => snapshot)
    await old
    await postHookEvent(server, body())
    finish({ ...snapshot, paneKey: GOOD_PANE, worktreeId: 'wt-other' })
    expect(server.getProviderSessionIdentities()).toEqual([
      expect.objectContaining({ paneKey: PANE, worktreeId: 'wt-1', sessionId })
    ])
    expect(server.getContextIntegrityRejections()).toEqual({})
  })

  it('rejects a provider whose stored workspace differs even when its pane key is unchanged', async () => {
    const server = await historicalServer()
    const original = server.getProviderSessionIdentities()
    server.setHookContextSnapshotReader(async () => ({ ...snapshot, paneKey: GOOD_PANE }))
    server.setHookRootEvidenceReader(async () => ({ verdict: 'root', binding: 'generation-b' }))
    await postHookEvent(server, { ...body(), paneKey: GOOD_PANE, tabId: 'tab-good' })
    expect(server.getContextIntegrityRejections()).toHaveProperty(
      'provider_owned_by_another_pane',
      1
    )
    expect(server.getProviderSessionIdentities()).toEqual(original)
  })

  it('blocks tool plugins before rejected context can acquire a terminal owner', async () => {
    const run = vi.fn(async (_event: string, payload: unknown) => ({
      kind: 'continue' as const,
      payload
    }))
    setPluginHookRunner({ wants: () => true, run })
    const server = await serverWithContext()
    await postHookEvent(
      server,
      buildBody(
        { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {}, cwd: '/workspace-a' },
        { agentProcess: processIdentity }
      )
    )
    expect(run).not.toHaveBeenCalled()
    expect(server.getStatusSnapshot()).toEqual([])
  })

  it('applies the same context refusal to spool replay and unsupported remote attestations', async () => {
    const server = await serverWithContext()
    await server.replay({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      env: 'production',
      source: 'claude',
      receivedAt: NOW,
      agentProcess: processIdentity,
      payload: body('/workspace-a').payload
    })
    server.ingestRemote(
      {
        paneKey: PANE,
        worktreeId: 'wt-1',
        providerSession: { key: 'session_id', id: sessionId },
        payload: { state: 'done', prompt: '', agentType: 'codex' }
      },
      'ssh-other'
    )
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getContextIntegrityRejections()).toHaveProperty(
      'remote_context_attestation_unavailable',
      1
    )
  })

  it('does not treat a configured default argument or matching CWD as missing Codex process proof', async () => {
    const server = await serverWithContext()
    const incoming = body()
    delete incoming.agentProcess
    await postHookEvent(server, incoming, '/hook/codex')
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getContextIntegrityRejections()).toHaveProperty(
      'process_generation_unconfirmed',
      1
    )
  })

  it('refuses untyped remote and terminal updates targeting a protected owner', async () => {
    const server = await serverWithContext()
    await postHookEvent(server, body())
    const original = server.getProviderSessionIdentities()
    server.ingestRemote({ paneKey: PANE, payload: { state: 'done', prompt: '' } }, 'ssh-other')
    server.ingestTerminalStatus({ paneKey: PANE, payload: { state: 'done', prompt: '' } })
    expect(server.getProviderSessionIdentities()).toEqual(original)
    expect(server.getContextIntegrityRejections()).toMatchObject({
      remote_context_attestation_unavailable: 1,
      terminal_context_attestation_unavailable: 1
    })
  })

  it('refuses a different source route and spool source targeting a protected owner', async () => {
    const server = await serverWithContext()
    await postHookEvent(server, body())
    const original = server.getProviderSessionIdentities()
    await postHookEvent(server, body(), '/hook/jcode')
    await server.replay({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      env: 'production',
      source: 'jcode',
      receivedAt: NOW,
      payload: body().payload
    })
    expect(server.getProviderSessionIdentities()).toEqual(original)
    expect(server.getContextIntegrityRejections()).toHaveProperty(
      'unattested_source_targets_protected_pane',
      2
    )
  })

  it.each(['/claude/agent-view', '/statusline/claude'])(
    'refuses auxiliary attribution without a supported context proof: %s',
    async (path) => {
      const server = await serverWithContext()
      await postHookEvent(server, body(), path)
      expect(server.getProviderSessionIdentities()).toEqual([])
      expect(server.getContextIntegrityRejections()).toHaveProperty(
        'auxiliary_context_attestation_unavailable',
        1
      )
    }
  )

  it('refuses an earlier launch capability even if the nominated process still looks live', async () => {
    const server = await serverWithContext()
    await postHookEvent(server, { ...body(), launchToken: 'old-capability' })
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getContextIntegrityRejections()).toHaveProperty(
      'launch_generation_unconfirmed',
      1
    )
  })
})
