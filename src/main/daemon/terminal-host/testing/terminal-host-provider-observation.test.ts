import '../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import { TerminalHost } from '../terminal-host'
import { createMockSubprocess } from '../../providers/adapter/testing/daemon-pty-adapter-test-harness'
import { composeWorktreeId } from '../../../../shared/worktree/id'
import type { HookProviderObservationUpdate } from '../../../../shared/agent-hook-listener/state/hook-provider-observation'

const OWNER = 'a'.repeat(64)
const HASH = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const INTENT = { agentType: 'claude' as const, providerSessionId: 'original-conversation' }
const streams = () => ({ onData() {}, onExit() {} })
let root: string
let host: TerminalHost
let attachment: symbol
let update: HookProviderObservationUpdate
const subprocesses: ReturnType<typeof createMockSubprocess>[] = []

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'orca-provider-observation-host-'))
  host = new TerminalHost({
    spawnSubprocess: () => {
      const subprocess = createMockSubprocess()
      subprocesses.push(subprocess)
      return subprocess
    }
  })
  const worktreeId = composeWorktreeId('fixture-repo', root)
  const ptyId = `${worktreeId}@@observation`
  const created = await host.createOrAttach({
    sessionId: ptyId,
    cols: 80,
    rows: 24,
    cwd: root,
    env: {
      ORCA_AGENT_HOOK_OWNER: OWNER,
      ORCA_AGENT_LAUNCH_TOKEN: 'abc',
      ORCA_PANE_KEY: PANE
    },
    launchAgent: 'claude',
    hookResumeIntent: INTENT,
    streamClient: streams()
  })
  attachment = created.attachToken
  update = {
    ptyId,
    incarnationId: created.incarnationId,
    paneKey: PANE,
    worktreeId,
    ownerClientInstanceId: OWNER,
    launchTokenHash: HASH,
    launchCwd: root,
    cwd: normalize(await realpath(root)),
    expectedRevision: 0,
    agentType: 'claude',
    providerSessionId: 'original-conversation',
    transition: 'observed',
    launchToken: 'abc'
  }
})

afterEach(async () => {
  for (const subprocess of subprocesses.splice(0)) {
    subprocess._simulateExit(0)
  }
  await host.dispose()
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith('orca-provider-observation-host-')
  ) {
    throw new Error('Refusing cleanup outside own host observation fixture')
  }
  rmSync(root, { recursive: true, force: true })
})

it('records the requested ID without rewriting the immutable launch request or retaining its capability', async () => {
  const recorded = await host.recordProviderObservation(update, attachment)
  expect(recorded).toMatchObject({
    revision: 1,
    providerSessionId: 'original-conversation',
    originalProviderSessionId: 'original-conversation',
    transition: 'requested-id-matched'
  })
  expect(recorded).not.toHaveProperty('launchToken')
  expect(host.listSessions()[0]).toMatchObject({
    hookContext: { resumeIntent: INTENT },
    providerObservation: { revision: 1, providerSessionId: 'original-conversation' }
  })
})

it('keeps a verified clear through reattach and refuses both stale and unrelated requested IDs', async () => {
  await host.recordProviderObservation(update, attachment)
  const cleared = await host.recordProviderObservation(
    {
      ...update,
      expectedRevision: 1,
      providerSessionId: 'cleared-conversation',
      transition: 'clear'
    },
    attachment
  )
  expect(cleared).toMatchObject({
    revision: 2,
    originalProviderSessionId: 'original-conversation',
    providerSessionId: 'cleared-conversation',
    transition: 'clear'
  })
  const request = {
    sessionId: update.ptyId,
    cols: 80,
    rows: 24,
    streamClient: streams(),
    hookResumeIntent: { ...INTENT, providerSessionId: 'cleared-conversation' }
  }
  for (const providerSessionId of ['original-conversation', 'unrelated-conversation']) {
    await expect(
      host.createOrAttach({ ...request, hookResumeIntent: { ...INTENT, providerSessionId } })
    ).rejects.toThrow('agent_resume_intent_mismatch')
  }
  const reattached = await host.createOrAttach(request)
  expect(reattached.isNew).toBe(false)
  expect(reattached.incarnationId).toBe(update.incarnationId)
  expect(host.listSessions()[0]?.hookContext?.resumeIntent).toEqual(INTENT)
  await expect(
    host.recordProviderObservation({ ...update, expectedRevision: 2 }, attachment)
  ).rejects.toThrow('hook_provider_observation_scope_unconfirmed')
})

it('rejects a symbol not held by an actual attached client', async () => {
  await expect(host.recordProviderObservation(update, Symbol('foreign'))).rejects.toThrow(
    'hook_provider_observation_scope_unconfirmed'
  )
  expect(host.listSessions()[0]?.providerObservation).toBeUndefined()
})

it.each([
  { incarnationId: 'other-generation' },
  { paneKey: 'tab-other:22222222-2222-4222-8222-222222222222' },
  { worktreeId: 'other-workspace' },
  { ownerClientInstanceId: 'b'.repeat(64) },
  { launchTokenHash: 'b'.repeat(64) },
  { launchToken: 'other-capability' },
  { launchCwd: '/other-workspace' },
  { agentType: 'codex' as const }
])('rejects a mismatched host-owned scope without creating an observation', async (changed) => {
  await expect(
    host.recordProviderObservation({ ...update, ...changed }, attachment)
  ).rejects.toThrow('hook_provider_observation_scope_unconfirmed')
  expect(host.listSessions()[0]?.providerObservation).toBeUndefined()
})

it('rejects a contradictory initial provider ID even with a valid attached capability', async () => {
  await expect(
    host.recordProviderObservation(
      { ...update, providerSessionId: 'unexpected-conversation' },
      attachment
    )
  ).rejects.toThrow('hook_provider_observation_original_unconfirmed')
  expect(host.listSessions()[0]?.providerObservation).toBeUndefined()
})

it('rejects a stale revision without overwriting a later observed provider', async () => {
  await host.recordProviderObservation(update, attachment)
  await expect(
    host.recordProviderObservation(
      { ...update, providerSessionId: 'cleared-conversation', transition: 'clear' },
      attachment
    )
  ).rejects.toThrow('hook_provider_observation_revision_changed')
  expect(host.listSessions()[0]?.providerObservation?.providerSessionId).toBe(
    'original-conversation'
  )
})

it('does not accept an unannounced change after the first observed ID', async () => {
  await host.recordProviderObservation(update, attachment)
  await expect(
    host.recordProviderObservation(
      { ...update, expectedRevision: 1, providerSessionId: 'unexpected-conversation' },
      attachment
    )
  ).rejects.toThrow('hook_provider_observation_transition_unconfirmed')
})

it('rechecks the active attachment after canonicalizing the launch directory', async () => {
  const pending = host.recordProviderObservation(update, attachment)
  host.detach(update.ptyId, attachment)
  await expect(pending).rejects.toThrow('hook_provider_observation_scope_changed')
  expect(host.listSessions()[0]?.providerObservation).toBeUndefined()
})

it('rejects first-write clear instead of inventing an original observation', async () => {
  await expect(
    host.recordProviderObservation({ ...update, transition: 'clear' }, attachment)
  ).rejects.toThrow('hook_provider_observation_transition_unconfirmed')
  expect(host.listSessions()[0]?.providerObservation).toBeUndefined()
})

it('rejects canonical path spelling differences before committing a revision', async () => {
  await expect(
    host.recordProviderObservation({ ...update, cwd: `${update.cwd}/` }, attachment)
  ).rejects.toThrow('hook_provider_observation_scope_changed')
  expect(host.listSessions()[0]?.providerObservation).toBeUndefined()
  expect((await host.recordProviderObservation(update, attachment)).revision).toBe(1)
})

it('checks the actual launch agent even when no original resume intent exists', async () => {
  const created = await host.createOrAttach({
    sessionId: `${update.worktreeId}@@fresh-observation`,
    cols: 80,
    rows: 24,
    cwd: root,
    env: {
      ORCA_AGENT_HOOK_OWNER: OWNER,
      ORCA_AGENT_LAUNCH_TOKEN: 'abc',
      ORCA_PANE_KEY: PANE
    },
    launchAgent: 'claude',
    hookResumeIntent: null,
    streamClient: streams()
  })
  await expect(
    host.recordProviderObservation(
      {
        ...update,
        ptyId: `${update.worktreeId}@@fresh-observation`,
        incarnationId: created.incarnationId,
        agentType: 'codex'
      },
      created.attachToken
    )
  ).rejects.toThrow('hook_provider_observation_scope_unconfirmed')
  expect(
    host.listSessions().find((session) => session.incarnationId === created.incarnationId)
      ?.providerObservation
  ).toBeUndefined()
})
