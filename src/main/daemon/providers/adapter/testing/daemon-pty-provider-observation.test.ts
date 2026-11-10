import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, normalize, resolve } from 'node:path'
import { DaemonPtyAdapter } from '../daemon-pty-adapter'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'
import { composeWorktreeId } from '../../../../../shared/worktree/id'
import type { HookProviderObservationUpdate } from '../../../../../shared/agent-hook-listener/state/hook-provider-observation'
import { AgentHookServer } from '../../../../agent-hooks/server/agent-hook-server'
import {
  buildBody,
  postHookEvent
} from '../../../../agent-hooks/server/testing/server.test-fixtures'
import { createLocalPtyInventoryReader } from '../../../../agent-hooks/observations/local-tmux-managed-pty'
import { createLocalHookContextSnapshotReader } from '../../../../agent-hooks/local-hook-context-snapshot'
import { createLocalProviderObservationWriter } from '../../../../agent-hooks/local-provider-observation-writer'
import { createLegacyDaemonAdapters } from '../../routing/daemon-legacy-adapters'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>>
let update: HookProviderObservationUpdate
let opts: Parameters<DaemonPtyAdapter['spawn']>[0]
const extraClients: DaemonPtyAdapter[] = []
const subprocesses: ReturnType<typeof createMockSubprocess>[] = []
const hookServers: AgentHookServer[] = []
const legacyHarnesses: (typeof harness)[] = []

beforeEach(async () => {
  harness = await startDaemonAdapterHarness(() => {
    const subprocess = createMockSubprocess()
    subprocesses.push(subprocess)
    return subprocess
  })
  const worktreeId = composeWorktreeId('fixture-repo', harness.dir)
  opts = {
    cols: 80,
    rows: 24,
    cwd: harness.dir,
    worktreeId,
    sessionId: `${worktreeId}@@provider-observation`,
    launchAgent: 'claude',
    hookResumeIntent: { agentType: 'claude', providerSessionId: 'original-conversation' },
    env: {
      ORCA_AGENT_HOOK_OWNER: 'a'.repeat(64),
      ORCA_AGENT_LAUNCH_TOKEN: 'abc',
      ORCA_PANE_KEY: 'tab-1:11111111-1111-4111-8111-111111111111'
    }
  }
  const created = await harness.adapter.spawn(opts)
  if (!created.incarnationId) {
    throw new Error('Own fixture did not return an incarnation')
  }
  update = {
    ptyId: created.id,
    incarnationId: created.incarnationId,
    paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
    worktreeId,
    ownerClientInstanceId: 'a'.repeat(64),
    launchTokenHash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    launchCwd: harness.dir,
    cwd: normalize(await realpath(harness.dir)),
    expectedRevision: 0,
    agentType: 'claude',
    providerSessionId: 'original-conversation',
    transition: 'observed',
    launchToken: 'abc'
  }
})

afterEach(async () => {
  for (const server of hookServers.splice(0)) {
    server.stop()
  }
  for (const subprocess of subprocesses.splice(0)) {
    subprocess._simulateExit(0)
  }
  for (const client of extraClients.splice(0)) {
    client.dispose()
  }
  for (const owned of [...legacyHarnesses.splice(0), harness]) {
    await cleanupHarness(owned)
  }
})

async function cleanupHarness(owned: typeof harness) {
  owned.adapter.dispose()
  await owned.server.shutdown()
  const root = resolve(owned.dir)
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('daemon-adapter-test-')) {
    throw new Error('Refusing cleanup outside own observation protocol fixture')
  }
  rmSync(root, { recursive: true, force: true })
}

function anotherClient(protocolVersion?: number) {
  const client = new DaemonPtyAdapter({
    socketPath: harness.socketPath,
    tokenPath: harness.tokenPath,
    ...(protocolVersion !== undefined ? { protocolVersion } : {})
  })
  extraClients.push(client)
  return client
}

it('keeps a scoped clear through a different main-client attachment without changing the PTY', async () => {
  expect(await harness.adapter.recordHookProviderObservation(update)).toMatchObject({ revision: 1 })
  const cleared = await harness.adapter.recordHookProviderObservation({
    ...update,
    expectedRevision: 1,
    providerSessionId: 'cleared-conversation',
    transition: 'clear'
  })
  expect(cleared).toMatchObject({ revision: 2, providerSessionId: 'cleared-conversation' })
  expect((await harness.adapter.listProcesses())[0]?.providerObservation).toMatchObject({
    revision: 2,
    providerSessionId: 'cleared-conversation'
  })
  const restarted = anotherClient()
  const attached = await restarted.spawn({
    ...opts,
    hookResumeIntent: { agentType: 'claude', providerSessionId: 'cleared-conversation' }
  })
  expect(attached.isReattach).toBe(true)
  expect(attached.incarnationId).toBe(update.incarnationId)
  await expect(
    harness.adapter.recordHookProviderObservation({
      ...update,
      expectedRevision: 2,
      providerSessionId: 'third-conversation',
      transition: 'clear'
    })
  ).rejects.toThrow('hook_provider_observation_not_owner')
  expect(
    await restarted.recordHookProviderObservation({
      ...update,
      expectedRevision: 2,
      providerSessionId: 'third-conversation',
      transition: 'clear'
    })
  ).toMatchObject({ revision: 3, providerSessionId: 'third-conversation' })
})

it('refuses an authenticated client which does not own the active attachment', async () => {
  await expect(anotherClient().recordHookProviderObservation(update)).rejects.toThrow(
    'hook_provider_observation_not_owner'
  )
  expect((await harness.adapter.listProcesses())[0]?.providerObservation).toBeUndefined()
})

it('does not invoke a new observation RPC on an older protocol', async () => {
  expect(await anotherClient(55).recordHookProviderObservation(update)).toBeNull()
  expect((await harness.adapter.listProcesses())[0]?.providerObservation).toBeUndefined()
})

it('keeps protocol55 discoverable and its raw terminals available without a new observation RPC', async () => {
  const child = createMockSubprocess()
  subprocesses.push(child)
  const legacy = await startDaemonAdapterHarness(
    () => child,
    { protocolVersion: 55 },
    { protocolVersion: 55 }
  )
  legacyHarnesses.push(legacy)
  const created = await legacy.adapter.spawn({ ...opts, cwd: legacy.dir })
  const discovered = await createLegacyDaemonAdapters(legacy.dir, join(legacy.dir, 'history'))
  extraClients.push(...discovered)
  const rows = (await Promise.all(discovered.map((adapter) => adapter.listProcesses()))).flat()
  expect(rows.map((row) => row.id)).toContain(created.id)
  expect(await legacy.adapter.recordHookProviderObservation(update)).toBeNull()
  const current = (await legacy.adapter.listProcesses())[0]
  expect(current?.incarnationId).toBe(created.incarnationId)
  expect(current?.exiting).toBeUndefined()
})

it('recovers a lost acknowledgement through a fresh owner-checked idempotent RPC', async () => {
  await harness.adapter.recordHookProviderObservation(update)
  const inventory = createLocalPtyInventoryReader({
    getPtyId: () => update.ptyId,
    listProcesses: () => harness.adapter.listProcesses()
  })
  const write = createLocalProviderObservationWriter(inventory, () => harness.adapter)
  expect(await write(update)).toMatchObject({
    revision: 1,
    providerSessionId: 'original-conversation'
  })
  const client = anotherClient()
  await client.spawn(opts)
  await expect(write(update)).rejects.toThrow('hook_provider_observation_current_owner_unconfirmed')
  expect((await client.listProcesses())[0]?.providerObservation?.revision).toBe(1)
})

it('drains a pending clear after hook stop and restores the same physical session in a new server', async () => {
  const releaseClear = Promise.withResolvers<void>()
  async function hookServer(adapter: DaemonPtyAdapter) {
    const server = new AgentHookServer()
    hookServers.push(server)
    await server.start({ env: 'production', userDataPath: harness.dir })
    const inventory = createLocalPtyInventoryReader({
      getPtyId: () => update.ptyId,
      listProcesses: () => adapter.listProcesses()
    })
    server.setHookContextSnapshotReader(
      createLocalHookContextSnapshotReader(inventory, undefined, update.ownerClientInstanceId)
    )
    // Synthetic root proof; this test exercises real daemon ownership/RPC, not OS ancestry.
    server.setHookRootEvidenceReader(async () => ({
      verdict: 'root',
      binding: update.incarnationId
    }))
    const write = createLocalProviderObservationWriter(inventory, () => adapter)
    server.setProviderObservationWriter(async (observation) => {
      if (observation.transition === 'clear') {
        await releaseClear.promise
      }
      return write(observation)
    })
    return server
  }
  async function post(
    server: AgentHookServer,
    id: string,
    event = 'SessionStart',
    source = 'resume'
  ) {
    const response = await postHookEvent(
      server,
      buildBody(
        {
          session_id: id,
          hook_event_name: event,
          source,
          cwd: update.cwd
        },
        {
          paneKey: update.paneKey,
          worktreeId: update.worktreeId,
          launchToken: update.launchToken,
          agentProcess: JSON.stringify({
            pid: 1001,
            platform: 'linux',
            startTime: 'synthetic-start'
          })
        }
      ),
      '/hook/claude'
    )
    expect(response.status).toBe(204)
  }
  const original = await hookServer(harness.adapter)
  await post(original, 'original-conversation')
  expect(await original.flushProviderObservations()).toBe(true)
  await post(original, 'cleared-conversation', 'SessionStart', 'clear')
  expect(original.hasPendingProviderObservations).toBe(true)
  original.stop({ keepStatus: true })
  const draining = original.flushProviderObservations()
  releaseClear.resolve()
  expect(await draining).toBe(true)
  expect((await harness.adapter.listProcesses())[0]?.providerObservation).toMatchObject({
    revision: 2,
    providerSessionId: 'cleared-conversation'
  })
  original.stop()
  const client = anotherClient()
  const attached = await client.spawn({
    ...opts,
    hookResumeIntent: { agentType: 'claude', providerSessionId: 'cleared-conversation' }
  })
  expect(attached.incarnationId).toBe(update.incarnationId)
  const restarted = await hookServer(client)
  await post(restarted, 'cleared-conversation', 'Stop')
  expect(restarted.getStatusSnapshotForPane(update.paneKey)[0]?.providerSession?.id).toBe(
    'cleared-conversation'
  )
  await post(restarted, 'original-conversation', 'Stop')
  await post(restarted, 'unrelated-conversation', 'Stop')
  expect(restarted.getStatusSnapshotForPane(update.paneKey)[0]?.providerSession?.id).toBe(
    'cleared-conversation'
  )
  expect(restarted.getContextIntegrityRejections()).toHaveProperty(
    'resume_provider_transition_unconfirmed',
    2
  )
  expect((await client.listProcesses())[0]?.incarnationId).toBe(update.incarnationId)
})
