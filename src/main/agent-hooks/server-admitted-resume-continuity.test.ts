import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { AtomicSnapshotWriter } from '../persistence/atomic-snapshot-writer'
import { AgentHookServer } from './server'
import { buildBody, PANE } from './server.test-fixtures'
import {
  createAdmittedResumeHost,
  postAdmittedFixtureHook
} from './admitted-resume-host.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

let root: string
const servers = new Set<AgentHookServer>()
const ORIGINAL = 'original-conversation'
let ownedHost: Awaited<ReturnType<typeof createAdmittedResumeHost>> | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-admitted-continuity-'))
})

afterEach(async () => {
  const host = ownedHost
  ownedHost = undefined
  vi.restoreAllMocks()
  for (const server of servers) {
    await server.flushProviderObservations()
    server.stop()
  }
  servers.clear()
  await host?.dispose()
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith('orca-admitted-continuity-')
  ) {
    throw new Error('Refusing cleanup outside own admitted continuity fixture')
  }
  rmSync(root, { recursive: true, force: true })
})

async function start(agentType: 'claude' | 'codex') {
  ownedHost ??= await createAdmittedResumeHost(root, agentType)
  const host = ownedHost
  const server = new AgentHookServer()
  servers.add(server)
  await server.start({ env: 'production', userDataPath: root })
  server.setHookContextSnapshotReader(host.read)
  server.setProviderObservationWriter(host.write)
  server.setHookRootEvidenceReader(async () => ({
    verdict: 'root',
    binding: host.incarnationId
  }))
  return server
}

function request(server: AgentHookServer, agentType: 'claude' | 'codex') {
  return server.recordLaunchResumeIdentity({
    paneKey: PANE,
    worktreeId: ownedHost?.worktreeId,
    agentType,
    providerSession: { key: 'session_id', id: ORIGINAL },
    launchedAt: 100
  })
}

async function hook(
  server: AgentHookServer,
  agent: 'claude' | 'codex',
  id: string,
  source = 'resume',
  hookEventName = 'SessionStart'
) {
  const status = await postAdmittedFixtureHook(
    server,
    buildBody(
      {
        hook_event_name: hookEventName,
        session_id: id,
        cwd: ownedHost?.cwd,
        source
      },
      {
        worktreeId: ownedHost?.worktreeId,
        launchToken: 'abc',
        agentProcess: JSON.stringify({ pid: 1001, platform: 'linux', startTime: 'synthetic-start' })
      }
    ),
    `/hook/${agent}`
  )
  expect(status).toBe(204)
  expect(await server.flushProviderObservations()).toBe(true)
  expect(
    Object.keys(server.getContextIntegrityRejections()).filter(
      (reason) => reason !== 'launch_context_attestation_unavailable'
    )
  ).toEqual([])
}

it.each(['claude', 'codex'] as const)(
  'retains an admitted original %s checkpoint through pane cleanup and server restart',
  async (agent) => {
    const server = await start(agent)
    expect(request(server, agent)).toBe('recorded')
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
    await hook(server, agent, ORIGINAL)
    expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(ORIGINAL)
    expect(await server.flushProviderObservations()).toBe(true)
    expect(ownedHost?.observations.map((row) => [row.providerSessionId, row.transition])).toEqual([
      [ORIGINAL, 'requested-id-matched']
    ])
    server.clearPaneState(PANE)
    expect(server.flushResumeIdentityCheckpoint()).toBe(true)
    const saved = JSON.parse(readFileSync(server.lastStatusPath!, 'utf8'))
    expect(saved.entries[PANE]).toMatchObject({
      providerSession: { id: ORIGINAL },
      runtimeResumeCheckpoint: true
    })
    expect(saved.entries[PANE]).not.toHaveProperty('launchToken')
    server.stop()
    servers.delete(server)
    const restarted = await start(agent)
    expect(restarted.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(ORIGINAL)
    expect(restarted.getStatusSnapshotForPane(PANE)[0]?.providerSessionOnly).toBe(true)
    await hook(restarted, agent, ORIGINAL)
    expect(restarted.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(ORIGINAL)
    expect(restarted.getStatusSnapshotForPane(PANE)[0]?.providerSessionOnly).toBeUndefined()
  }
)

it('retains a positively admitted Claude clear without replacing the original quiet request', async () => {
  const server = await start('claude')
  expect(request(server, 'claude')).toBe('recorded')
  await hook(server, 'claude', ORIGINAL)
  await hook(server, 'claude', 'cleared-conversation', 'clear')
  expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe('cleared-conversation')
  expect(await server.flushProviderObservations()).toBe(true)
  expect(ownedHost?.observations.map((row) => [row.providerSessionId, row.transition])).toEqual([
    [ORIGINAL, 'requested-id-matched'],
    ['cleared-conversation', 'clear']
  ])
  server.clearPaneState(PANE)
  expect(server.flushResumeIdentityCheckpoint()).toBe(true)
  server.stop()
  servers.delete(server)
  const restarted = await start('claude')
  expect(restarted.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(
    'cleared-conversation'
  )
  expect(restarted.getStatusSnapshotForPane(PANE)[0]?.providerSessionOnly).toBe(true)
  await hook(restarted, 'claude', 'cleared-conversation', 'resume', 'Stop')
  expect(restarted.getStatusSnapshotForPane(PANE)[0]?.providerSessionOnly).toBeUndefined()
  expect(restarted.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(
    'cleared-conversation'
  )
  expect(
    restarted
      .getUnverifiedResumeLaunchRecipesForPane(PANE, ownedHost?.worktreeId)
      .recipes.map((recipe) => recipe.providerSession.id)
  ).toEqual([ORIGINAL])
})

it('reports a failed admitted checkpoint while retaining the observed ID for a successful retry', async () => {
  const server = await start('codex')
  expect(request(server, 'codex')).toBe('recorded')
  await hook(server, 'codex', ORIGINAL)
  server.clearPaneState(PANE)
  const failed = vi.spyOn(AtomicSnapshotWriter.prototype, 'writeSync').mockImplementation(() => {
    throw new Error('Synthetic admitted checkpoint failure')
  })
  expect(server.flushResumeIdentityCheckpoint()).toBe(false)
  expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(ORIGINAL)
  failed.mockRestore()
  expect(server.flushResumeIdentityCheckpoint()).toBe(true)
  expect(
    JSON.parse(readFileSync(server.lastStatusPath!, 'utf8')).entries[PANE]?.providerSession.id
  ).toBe(ORIGINAL)
})

it('does not overwrite a first admitted hook when recording its late launch request', async () => {
  const server = await start('codex')
  await hook(server, 'codex', ORIGINAL)
  expect(request(server, 'codex')).toBe('recorded')
  expect(
    server
      .getUnverifiedResumeLaunchRecipesForPane(PANE, ownedHost?.worktreeId)
      .recipes.map((recipe) => recipe.providerSession.id)
  ).toEqual([ORIGINAL])
  expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id).toBe(ORIGINAL)
  expect(server.getStatusSnapshotForPane(PANE)[0]?.providerSessionOnly).toBeUndefined()
  server.clearPaneState(PANE)
  expect(server.flushResumeIdentityCheckpoint()).toBe(true)
  expect(JSON.parse(readFileSync(server.lastStatusPath!, 'utf8')).entries[PANE]).toMatchObject({
    providerSession: { id: ORIGINAL },
    runtimeResumeCheckpoint: true
  })
})
