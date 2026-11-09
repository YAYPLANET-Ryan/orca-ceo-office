import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import type { LocalPtyProvider } from './local-pty-provider'
import type { PtySpawnOptions } from '../pty-provider-contract'
import type { HookProviderObservationUpdate } from '../../../shared/agent-hook-listener/state/hook-provider-observation'
import type * as MacosTccLoginShell from '../macos-tcc-login-shell'
import { composeWorktreeId } from '../../../shared/worktree/id'
import {
  createLocalPtyMockProcess,
  type LocalPtyExitCallback
} from './local-pty-mock-process.test-fixtures'

const fixture = vi.hoisted(() => ({ root: '', spawn: vi.fn() }))
vi.mock('node-pty', () => ({ spawn: fixture.spawn }))
vi.mock('electron', () => ({ app: { getPath: () => fixture.root } }))
vi.mock('../macos-tcc-login-shell', async (importOriginal) => ({
  ...(await importOriginal<typeof MacosTccLoginShell>()),
  prepareMacosTccLoginShell: async () => undefined
}))
vi.mock('../../pty/process-retirement/pty-descendant-termination', () => ({
  killWithDescendantSweep: async (_pid: number, killRoot: () => void) => {
    killRoot()
  }
}))

let Provider: typeof LocalPtyProvider
let provider: LocalPtyProvider
let options: PtySpawnOptions
let update: HookProviderObservationUpdate
const exits: { callback?: LocalPtyExitCallback }[] = []
const originalUserData = process.env.ORCA_USER_DATA_PATH

beforeAll(async () => {
  fixture.root = mkdtempSync(join(tmpdir(), 'orca-local-observation-'))
  process.env.ORCA_USER_DATA_PATH = fixture.root
  Provider = (await import('./local-pty-provider')).LocalPtyProvider
})

beforeEach(async () => {
  fixture.spawn.mockImplementation(() => {
    const exit: { callback?: LocalPtyExitCallback } = {}
    exits.push(exit)
    const proc = createLocalPtyMockProcess({
      get: () => exit.callback,
      set: (callback) => {
        exit.callback = callback
      }
    })
    let cols = 80,
      rows = 24
    return {
      ...proc,
      pid: 999_999_999,
      get cols() {
        return cols
      },
      get rows() {
        return rows
      },
      resize: (nextCols: number, nextRows: number) => {
        cols = nextCols
        rows = nextRows
      }
    }
  })
  provider = new Provider({ isHistoryEnabled: () => false })
  const worktreeId = composeWorktreeId('fixture-repo', fixture.root)
  options = {
    sessionId: `${worktreeId}@@local-observation`,
    worktreeId,
    cols: 80,
    rows: 24,
    cwd: fixture.root,
    shellOverride:
      process.platform === 'win32'
        ? join(process.env.SystemRoot ?? 'C:/Windows', 'System32/cmd.exe')
        : '/bin/sh',
    launchAgent: 'claude',
    hookResumeIntent: { agentType: 'claude', providerSessionId: 'original-conversation' },
    env: {
      ORCA_AGENT_HOOK_OWNER: 'a'.repeat(64),
      ORCA_AGENT_LAUNCH_TOKEN: 'abc',
      ORCA_PANE_KEY: 'tab-1:11111111-1111-4111-8111-111111111111'
    }
  }
  const created = await provider.spawn(options)
  if (!created.incarnationId) {
    throw new Error('Own local fixture has no incarnation')
  }
  update = {
    ptyId: created.id,
    incarnationId: created.incarnationId,
    worktreeId,
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    ownerClientInstanceId: 'a'.repeat(64),
    launchTokenHash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    launchCwd: fixture.root,
    cwd: normalize(await realpath(fixture.root)),
    expectedRevision: 0,
    agentType: 'claude',
    providerSessionId: 'original-conversation',
    transition: 'observed',
    launchToken: 'abc'
  }
})

afterEach(() => {
  for (const exit of exits.splice(0)) {
    exit.callback?.({ exitCode: 0 })
  }
  provider.killAll()
})

afterAll(() => {
  if (originalUserData === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = originalUserData
  }
  const root = resolve(fixture.root)
  if (
    dirname(root) !== resolve(tmpdir()) ||
    !basename(root).startsWith('orca-local-observation-')
  ) {
    throw new Error('Refusing cleanup outside own local observation fixture')
  }
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

it('records an owned local observation without retaining its capability or replacing the original intent', async () => {
  const observation = await provider.recordHookProviderObservation(update)
  expect(observation).toMatchObject({ revision: 1, transition: 'requested-id-matched' })
  expect(observation).not.toHaveProperty('launchToken')
  expect((await provider.listProcesses())[0]).toMatchObject({
    hookResumeIntent: { agentType: 'claude', providerSessionId: 'original-conversation' },
    providerObservation: { revision: 1, providerSessionId: 'original-conversation' }
  })
})

it('reattaches the admitted clear and rejects old or unrelated IDs before resizing the live PTY', async () => {
  await provider.recordHookProviderObservation(update)
  await provider.recordHookProviderObservation({
    ...update,
    expectedRevision: 1,
    providerSessionId: 'cleared-conversation',
    transition: 'clear'
  })
  await expect(
    provider.recordHookProviderObservation({ ...update, expectedRevision: 2, transition: 'clear' })
  ).rejects.toThrow('hook_provider_observation_transition_unconfirmed')
  for (const providerSessionId of ['original-conversation', 'unrelated-conversation']) {
    await expect(
      provider.spawn({
        ...options,
        cols: 120,
        hookResumeIntent: { agentType: 'claude', providerSessionId }
      })
    ).rejects.toThrow('agent_resume_intent_mismatch')
  }
  expect(await provider.getAppliedSize(update.ptyId)).toEqual({ cols: 80, rows: 24 })
  const reattached = await provider.spawn({
    ...options,
    hookResumeIntent: { agentType: 'claude', providerSessionId: 'cleared-conversation' }
  })
  expect(reattached.isReattach).toBe(true)
  expect(reattached.incarnationId).toBe(update.incarnationId)
  expect((await provider.listProcesses())[0]?.hookResumeIntent?.providerSessionId).toBe(
    'original-conversation'
  )
})

it.each([
  { incarnationId: 'foreign-generation' },
  { paneKey: 'tab-other:22222222-2222-4222-8222-222222222222' },
  { worktreeId: 'foreign-workspace' },
  { ownerClientInstanceId: 'b'.repeat(64) },
  { launchTokenHash: 'c'.repeat(64) },
  { launchToken: 'other-capability' },
  { launchCwd: '/foreign-workspace' },
  { cwd: '/foreign-workspace' },
  { agentType: 'codex' as const }
])('does not lend local ownership to a mismatched observation', async (changed) => {
  await expect(provider.recordHookProviderObservation({ ...update, ...changed })).rejects.toThrow(
    /hook_provider_observation_scope_/
  )
  expect((await provider.listProcesses())[0]?.providerObservation).toBeUndefined()
})

it('refuses a fabricated first ID and a first clear without inventing a matching observation', async () => {
  await expect(
    provider.recordHookProviderObservation({ ...update, providerSessionId: 'unrelated' })
  ).rejects.toThrow('hook_provider_observation_original_unconfirmed')
  await expect(
    provider.recordHookProviderObservation({ ...update, transition: 'clear' })
  ).rejects.toThrow('hook_provider_observation_transition_unconfirmed')
  expect((await provider.recordHookProviderObservation(update)).revision).toBe(1)
})

it('rechecks physical ownership after canonicalizing the stored launch directory', async () => {
  const pending = provider.recordHookProviderObservation(update)
  exits[0]?.callback?.({ exitCode: 0 })
  await expect(pending).rejects.toThrow('hook_provider_observation_scope_changed')
  expect(await provider.listProcesses()).toEqual([])
})

it('does not lend a previous physical generation to a reused stable PTY ID', async () => {
  await provider.recordHookProviderObservation(update)
  exits[0]?.callback?.({ exitCode: 0 })
  const replacement = await provider.spawn(options)
  expect(replacement.incarnationId).not.toBe(update.incarnationId)
  await expect(provider.recordHookProviderObservation(update)).rejects.toThrow('scope_unconfirmed')
  expect((await provider.listProcesses())[0]?.providerObservation).toBeUndefined()
})

it('validates both concurrent requests before the losing request can resize the winner', async () => {
  const sessionId = `${update.worktreeId}@@concurrent-observation`
  const results = await Promise.allSettled([
    provider.spawn({ ...options, sessionId }),
    provider.spawn({
      ...options,
      sessionId,
      cols: 120,
      hookResumeIntent: { agentType: 'claude', providerSessionId: 'unrelated' }
    })
  ])
  expect(results[0]?.status).toBe('fulfilled')
  expect(results[1]).toMatchObject({
    status: 'rejected',
    reason: new Error('agent_resume_intent_mismatch')
  })
  expect(await provider.getAppliedSize(sessionId)).toEqual({ cols: 80, rows: 24 })
  expect((await provider.listProcesses()).map((row) => row.id)).toEqual([update.ptyId, sessionId])
})

it('rejects malformed explicit intent before touching the existing terminal', async () => {
  const invalid = { ...options, cols: 120 }
  Reflect.set(invalid, 'hookResumeIntent', { agentType: 'claude', providerSessionId: '' })
  await expect(provider.spawn(invalid)).rejects.toThrow('invalid_agent_resume_intent')
  expect(await provider.getAppliedSize(update.ptyId)).toEqual({ cols: 80, rows: 24 })
  expect((await provider.listProcesses())[0]?.incarnationId).toBe(update.incarnationId)
})

it('serializes competing clear observations without losing the winning revision', async () => {
  await provider.recordHookProviderObservation(update)
  const results = await Promise.allSettled(
    ['clear-one', 'clear-two'].map((providerSessionId) =>
      provider.recordHookProviderObservation({
        ...update,
        expectedRevision: 1,
        providerSessionId,
        transition: 'clear'
      })
    )
  )
  const winner = results.find((result) => result.status === 'fulfilled')
  expect(winner?.status).toBe('fulfilled')
  expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
  if (winner?.status !== 'fulfilled') {
    throw new Error('No clear observation was accepted')
  }
  expect((await provider.listProcesses())[0]?.providerObservation).toEqual(winner.value)
  expect(winner.value.revision).toBe(2)
})

it('distinguishes explicit fresh intent from unavailable intent while preserving raw attachment', async () => {
  for (const hookResumeIntent of [null, undefined]) {
    const sessionId = `${update.worktreeId}@@intent-${String(hookResumeIntent)}`
    const created = await provider.spawn({ ...options, sessionId, hookResumeIntent })
    const attached = await provider.spawn({ ...options, sessionId, hookResumeIntent })
    expect(attached.incarnationId).toBe(created.incarnationId)
    await expect(provider.spawn({ ...options, sessionId, cols: 120 })).rejects.toThrow(
      hookResumeIntent === null ? 'agent_resume_intent_mismatch' : 'agent_resume_intent_unavailable'
    )
    expect(await provider.getAppliedSize(sessionId)).toEqual({ cols: 80, rows: 24 })
    expect(
      (await provider.spawn({ ...options, sessionId, hookResumeIntent: undefined })).isReattach
    ).toBe(true)
  }
})
