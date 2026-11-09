import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import * as hookNormalization from '../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import type { SpoolRecord } from '../../shared/agent-hook-listener/transport/agent-hook-spool'

class RequestedProviderTestServer extends AgentHookServer {
  replay(record: SpoolRecord) {
    return this.ingestSpoolRecord(record)
  }
}

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

let root: string
let server: RequestedProviderTestServer
let generation: string
const NOW = 1800000000000

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW)
  root = mkdtempSync(join(tmpdir(), 'orca-requested-provider-'))
  generation = 'generation-a'
  server = new RequestedProviderTestServer()
  await server.start({ env: 'production', userDataPath: root })
})

afterEach(() => {
  server.stop()
  vi.restoreAllMocks()
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith('orca-requested-provider-')
  ) {
    throw new Error('Refusing cleanup outside own requested-provider fixture')
  }
  rmSync(root, { recursive: true, force: true })
})

function configure(agentType: 'claude' | 'codex') {
  server.setHookContextSnapshotReader(async (envelope) => ({
    executionHostId: 'local',
    paneKey: PANE,
    worktreeId: 'wt-1',
    ptyId: 'pty-a',
    incarnationId: generation,
    launchTokenHash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    cwd: '/workspace-a',
    reportedCwd:
      typeof envelope.hookPayloadRecord.cwd === 'string' ? envelope.hookPayloadRecord.cwd : '',
    resumeIntent: { agentType, providerSessionId: 'original-conversation' }
  }))
  server.setHookRootEvidenceReader(async () => ({ verdict: 'root', binding: generation }))
}

async function hook(
  agent: 'claude' | 'codex',
  id: string,
  eventName = 'SessionStart',
  source = 'resume'
) {
  const response = await postHookEvent(
    server,
    buildBody(
      { hook_event_name: eventName, session_id: id, source, cwd: '/workspace-a' },
      {
        launchToken: 'abc',
        agentProcess: JSON.stringify({ pid: 1001, platform: 'linux', startTime: 'synthetic-start' })
      }
    ),
    `/hook/${agent}`
  )
  expect(response.status).toBe(204)
}

it.each(['claude', 'codex'] as const)(
  'refuses a first %s hook for a different ID while retaining the original request',
  async (agentType) => {
    configure(agentType)
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      worktreeId: 'wt-1',
      agentType,
      providerSession: { key: 'session_id', id: 'original-conversation' },
      launchedAt: 100
    })
    await hook(agentType, 'unexpected-conversation', 'SessionStart', 'startup')
    expect(server.getProviderSessionIdentities()).toEqual([])
    expect(
      server.getUnverifiedResumeLaunchRecipesForPane(PANE, 'wt-1').recipes[0]?.providerSession.id
    ).toBe('original-conversation')
    expect(server.getContextIntegrityRejections()).toHaveProperty('resume_provider_id_mismatch', 1)
  }
)

it('admits the requested original ID and refuses an unannounced replacement', async () => {
  configure('claude')
  await hook('claude', 'original-conversation')
  expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(
    'original-conversation'
  )
  await hook('claude', 'unexpected-conversation', 'Stop')
  expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(
    'original-conversation'
  )
})

it('permits an explicit Claude clear only after matching the original ID in the same generation', async () => {
  configure('claude')
  await hook('claude', 'unexpected-conversation', 'SessionStart', 'clear')
  expect(server.getProviderSessionIdentities()).toEqual([])
  await hook('claude', 'original-conversation')
  await hook('claude', 'cleared-conversation', 'SessionStart', 'clear')
  expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe('cleared-conversation')
  await hook('claude', 'cleared-conversation', 'Stop')
  await hook('claude', 'original-conversation', 'Stop')
  expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe('cleared-conversation')
  expect(server.getContextIntegrityRejections()).toHaveProperty(
    'resume_provider_transition_unconfirmed',
    1
  )
})

it('does not lend a successful first match to a new PTY incarnation', async () => {
  configure('claude')
  await hook('claude', 'original-conversation')
  generation = 'generation-b'
  await hook('claude', 'unexpected-conversation', 'SessionStart', 'clear')
  expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(
    'original-conversation'
  )
})

it('refuses the other provider even when it claims the requested ID', async () => {
  configure('codex')
  await hook('claude', 'original-conversation')
  expect(server.getProviderSessionIdentities()).toEqual([])
})

it('rechecks the normalized ID before allowing an active identity mutation', async () => {
  configure('claude')
  const normalize = hookNormalization.normalizeHookPayload
  vi.spyOn(hookNormalization, 'normalizeHookPayload').mockImplementation((...args) => {
    const event = normalize(...args)
    return event
      ? { ...event, providerSession: { key: 'session_id', id: 'unexpected-conversation' } }
      : event
  })
  await hook('claude', 'original-conversation')
  expect(server.getProviderSessionIdentities()).toEqual([])
  expect(server.getContextIntegrityRejections()).toHaveProperty('resume_provider_id_mismatch', 1)
})

it('does not establish a first match from replay or lend it to a later clear', async () => {
  configure('claude')
  await server.replay({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    env: 'production',
    source: 'claude',
    receivedAt: NOW,
    launchToken: 'abc',
    agentProcess: JSON.stringify({ pid: 1001, platform: 'linux', startTime: 'synthetic-start' }),
    payload: {
      hook_event_name: 'SessionStart',
      session_id: 'original-conversation',
      cwd: '/workspace-a',
      source: 'resume'
    }
  })
  expect(server.getProviderSessionIdentities()).toEqual([])
  expect(server.getContextIntegrityRejections()).toHaveProperty(
    'resume_provider_replay_unverified',
    1
  )
  await hook('claude', 'unexpected-conversation', 'SessionStart', 'clear')
  expect(server.getProviderSessionIdentities()).toEqual([])
})

it('does not invent a Codex in-process clear contract from a synthetic hook', async () => {
  configure('codex')
  await hook('codex', 'original-conversation')
  await hook('codex', 'unexpected-conversation', 'SessionStart', 'clear')
  expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(
    'original-conversation'
  )
  expect(server.getContextIntegrityRejections()).toHaveProperty(
    'resume_provider_transition_unconfirmed',
    1
  )
})

it('does not treat an unverified Claude fork source as a supported transition', async () => {
  configure('claude')
  await hook('claude', 'original-conversation')
  await hook('claude', 'unexpected-conversation', 'SessionStart', 'fork')
  expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(
    'original-conversation'
  )
  expect(server.getContextIntegrityRejections()).toHaveProperty(
    'resume_provider_transition_unconfirmed',
    1
  )
})

it('keeps admitted status and the matched provider consistent across concurrent clear hooks', async () => {
  configure('claude')
  await hook('claude', 'original-conversation')
  await Promise.all([
    hook('claude', 'clear-one', 'SessionStart', 'clear'),
    hook('claude', 'clear-two', 'SessionStart', 'clear')
  ])
  const accepted = server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id
  expect(['clear-one', 'clear-two']).toContain(accepted)
  if (!accepted) {
    throw new Error('Neither verified clear was committed')
  }
  await hook('claude', accepted, 'Stop')
  expect(server.getContextIntegrityRejections()).not.toHaveProperty(
    'resume_provider_transition_unconfirmed'
  )
})
