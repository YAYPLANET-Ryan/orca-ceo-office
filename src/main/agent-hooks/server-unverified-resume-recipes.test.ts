import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { AgentHookServer } from './server'
import { ResumeLaunchRecipeJournal } from './server/resume-launch-recipe-journal'
import { PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const request = {
  paneKey: PANE,
  worktreeId: 'workspace-a',
  agentType: 'codex',
  providerSession: { key: 'session_id' as const, id: 'original-conversation', cwd: '/workspace-a' },
  launchedAt: 100
}
let root: string
const servers = new Set<AgentHookServer>()

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-server-resume-recipes-'))
})

afterEach(() => {
  for (const server of servers) {
    server.stop()
  }
  servers.clear()
  vi.restoreAllMocks()
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith('orca-server-resume-recipes-')
  ) {
    throw new Error('Refusing cleanup outside own server recipe fixture')
  }
  rmSync(root, { recursive: true, force: true })
})

async function start(profile = 'profile-a', statusHooksEnabled = true) {
  const server = new AgentHookServer()
  servers.add(server)
  await server.start({ env: 'production', userDataPath: join(root, profile), statusHooksEnabled })
  return server
}

it.each(['claude', 'codex'])(
  'persists a quiet %s request without publishing active provider identity',
  async (agentType) => {
    const server = await start()
    expect(server.recordLaunchResumeIdentity({ ...request, agentType })).toBe('recorded')
    expect(server.getProviderSessionIdentities()).toEqual([])
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
    server.clearPaneState(PANE)
    expect(server.flushResumeIdentityCheckpoint()).toBe(true)
    server.stop()
    const restarted = await start()
    expect(restarted.getUnverifiedResumeLaunchRecipesForPane(PANE, 'workspace-a')).toMatchObject({
      unavailable: false,
      pending: false,
      recipes: [
        {
          verification: 'unverified',
          agentType,
          providerSession: { id: 'original-conversation', cwd: '/workspace-a' }
        }
      ]
    })
    expect(restarted.getProviderSessionIdentities()).toEqual([])
  }
)

it('keeps the original request when the status cache is rebuilt without rows', async () => {
  const server = await start()
  server.recordLaunchResumeIdentity(request)
  expect(server.flushResumeIdentityCheckpoint()).toBe(true)
  server.stop()
  writeFileSync(
    join(root, 'profile-a', 'agent-hooks', 'last-status.json'),
    JSON.stringify({ version: 2, entries: {} })
  )
  const restarted = await start()
  expect(
    restarted.getUnverifiedResumeLaunchRecipesForPane(PANE, 'workspace-a').recipes[0]
      ?.providerSession.id
  ).toBe('original-conversation')
  expect(restarted.getProviderSessionIdentities()).toEqual([])
})

it('reports failed storage while retaining the unverified request in memory', async () => {
  const server = await start()
  const failed = vi.spyOn(ResumeLaunchRecipeJournal.prototype, 'flush').mockReturnValue(false)
  expect(server.recordLaunchResumeIdentity(request)).toBe('recorded')
  expect(server.flushResumeIdentityCheckpoint()).toBe(false)
  expect(server.getUnverifiedResumeLaunchRecipesForPane(PANE, 'workspace-a')).toMatchObject({
    pending: true,
    recipes: [{ providerSession: { id: 'original-conversation' } }]
  })
  expect(server.getProviderSessionIdentities()).toEqual([])
  failed.mockRestore()
  expect(server.flushResumeIdentityCheckpoint()).toBe(true)
})

it('keeps profile-failed writes private during a profile switch and retries only in their original profile', async () => {
  const server = await start()
  const failed = vi.spyOn(ResumeLaunchRecipeJournal.prototype, 'flush').mockReturnValue(false)
  server.recordLaunchResumeIdentity(request)
  expect(server.flushResumeIdentityCheckpoint()).toBe(false)
  server.stop()
  await server.start({ env: 'production', userDataPath: join(root, 'profile-b') })
  expect(server.getUnverifiedResumeLaunchRecipesForPane(PANE, 'workspace-a')).toMatchObject({
    unavailable: true,
    recipes: []
  })
  expect(server.recordLaunchResumeIdentity({ ...request, launchedAt: 101 })).toBe('refused')
  failed.mockRestore()
  server.stop()
  await server.start({ env: 'production', userDataPath: join(root, 'profile-a') })
  expect(server.flushResumeIdentityCheckpoint()).toBe(true)
  expect(
    server.getUnverifiedResumeLaunchRecipesForPane(PANE, 'workspace-a').recipes[0]?.providerSession
      .id
  ).toBe('original-conversation')
  expect(
    server.getUnverifiedResumeLaunchRecipesForPane(PANE, 'workspace-a').recipes[0]?.providerSession
      .id
  ).toBe('original-conversation')
})

it('flushes quiet requests on stop even when status hooks are disabled', async () => {
  const server = await start('profile-a', false)
  expect(server.recordLaunchResumeIdentity(request)).toBe('recorded')
  expect(server.flushResumeIdentityCheckpoint()).toBe(true)
  server.stop()
  const restarted = await start('profile-a', false)
  expect(
    restarted.getUnverifiedResumeLaunchRecipesForPane(PANE, 'workspace-a').recipes[0]
      ?.providerSession.id
  ).toBe('original-conversation')
  expect(restarted.getProviderSessionIdentities()).toEqual([])
})

it('does not abort teardown when journal flushing unexpectedly throws', async () => {
  const server = await start()
  server.recordLaunchResumeIdentity(request)
  const failed = vi.spyOn(ResumeLaunchRecipeJournal.prototype, 'flush').mockImplementation(() => {
    throw new Error('Synthetic journal cleanup failure')
  })
  expect(server.flushResumeIdentityCheckpoint()).toBe(false)
  expect(() => server.stop()).not.toThrow()
  failed.mockRestore()
  await server.start({ env: 'production', userDataPath: join(root, 'profile-a') })
  expect(server.flushResumeIdentityCheckpoint()).toBe(true)
})

it('does not fail unrelated status checkpoints because an unverified recipe store is blocked', async () => {
  const server = await start()
  const failed = vi.spyOn(ResumeLaunchRecipeJournal.prototype, 'flush').mockReturnValue(false)
  server.recordLaunchResumeIdentity(request)
  expect(server.flushResumeIdentityCheckpoint()).toBe(false)
  expect(server.flushResumeIdentityCheckpoint(false)).toBe(true)
  failed.mockRestore()
})

it.each([
  { ...request, paneKey: ` ${PANE}` },
  { ...request, paneKey: 'invalid-pane' },
  { ...request, paneKey: 'x'.repeat(20000) },
  { ...request, worktreeId: ' workspace-a' }
])('refuses malformed request keys without creating active or historical claims', async (event) => {
  const server = await start()
  expect(server.recordLaunchResumeIdentity(event)).toBe('refused')
  expect(server.getProviderSessionIdentities()).toEqual([])
  expect(server.getUnverifiedResumeLaunchRecipesForPane(PANE, 'workspace-a').recipes).toEqual([])
})

it('retains closed-tab history as closed metadata without active claims', async () => {
  vi.spyOn(Date, 'now').mockReturnValue(1000)
  const server = await start()
  server.recordLaunchResumeIdentity(request)
  server.dropStatusEntriesByTabPrefix('tab-1')
  expect(
    server.getUnverifiedResumeLaunchRecipesForPane(PANE, 'workspace-a').recipes[0]
  ).toMatchObject({ closedAt: 1000, providerSession: { id: 'original-conversation' } })
  expect(server.getProviderSessionIdentities()).toEqual([])
  server.stop()
  const restarted = await start()
  expect(
    restarted.getUnverifiedResumeLaunchRecipesForPane(PANE, 'workspace-a').recipes[0]
  ).toMatchObject({ closedAt: 1000, providerSession: { id: 'original-conversation' } })
})

it('does not lend a pane history lookup across workspace boundaries', async () => {
  const server = await start()
  server.recordLaunchResumeIdentity(request)
  expect(server.flushResumeIdentityCheckpoint()).toBe(true)
  expect(server.getUnverifiedResumeLaunchRecipesForPane(PANE, 'workspace-b').recipes).toEqual([])
  expect(server.getUnverifiedResumeLaunchRecipesForPane(PANE).recipes).toEqual([])
  expect(
    server.getUnverifiedResumeLaunchRecipesForPane(PANE, 'workspace-a').recipes[0]?.providerSession
      .id
  ).toBe('original-conversation')
})
