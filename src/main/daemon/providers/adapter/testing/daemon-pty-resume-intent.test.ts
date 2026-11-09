import '../../../pty-subprocess/testing/mock-descendant-sweep'
import { afterEach, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import { createMockSubprocess, startDaemonAdapterHarness } from './daemon-pty-adapter-test-harness'

let harness: Awaited<ReturnType<typeof startDaemonAdapterHarness>> | undefined
const subprocesses: ReturnType<typeof createMockSubprocess>[] = []

afterEach(async () => {
  for (const subprocess of subprocesses.splice(0)) {
    subprocess._simulateExit(0)
  }
  if (!harness) {
    return
  }
  harness.adapter.dispose()
  await harness.server.shutdown()
  const root = resolve(harness.dir)
  if (dirname(root) !== resolve(tmpdir()) || !basename(root).startsWith('daemon-adapter-test-')) {
    throw new Error('Refusing cleanup outside own daemon intent fixture')
  }
  rmSync(root, { recursive: true, force: true })
  harness = undefined
})

it('round-trips resume intent and refuses a mismatched reattach before altering the original session', async () => {
  harness = await startDaemonAdapterHarness(() => {
    const subprocess = createMockSubprocess()
    subprocesses.push(subprocess)
    return subprocess
  })
  const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
  const intent = { agentType: 'codex' as const, providerSessionId: 'original-conversation' }
  const opts = {
    cols: 80,
    rows: 24,
    sessionId: 'wt@@intent',
    cwd: harness.dir,
    launchAgent: 'codex' as const,
    hookResumeIntent: intent,
    env: {
      ORCA_AGENT_HOOK_OWNER: 'a'.repeat(64),
      ORCA_AGENT_LAUNCH_TOKEN: 'abc',
      ORCA_PANE_KEY: paneKey
    }
  }
  await expect(
    harness.adapter.spawn({
      ...opts,
      hookResumeIntent: { ...intent, providerSessionId: '' }
    })
  ).rejects.toThrow('invalid_resume_intent')
  expect(await harness.adapter.listProcesses()).toEqual([])
  const first = await harness.adapter.spawn(opts)
  expect((await harness.adapter.listProcesses()).find((row) => row.id === first.id)).toMatchObject({
    hookResumeIntent: intent,
    ownerClientInstanceId: 'a'.repeat(64),
    launchTokenHash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    contextCwd: harness.dir,
    paneBound: true
  })
  const received: string[] = []
  const unsubscribe = harness.adapter.onData(({ id, data }) => {
    if (id === first.id) {
      received.push(data)
    }
  })
  await expect(
    harness.adapter.spawn({
      ...opts,
      hookResumeIntent: { ...intent, providerSessionId: 'other-conversation' }
    })
  ).rejects.toThrow('agent_resume_intent_mismatch')
  subprocesses[0]!._simulateData('after-refused-reattach')
  await vi.waitFor(() => expect(received.join('')).toContain('after-refused-reattach'))
  unsubscribe()
  const reattached = await harness.adapter.spawn(opts)
  expect(reattached.isReattach).toBe(true)
  expect((await harness.adapter.listProcesses()).find((row) => row.id === first.id)).toMatchObject({
    hookResumeIntent: intent
  })
})

it.each([null, { agentType: 'codex' as const, providerSessionId: 'original-conversation' }])(
  'reports missing original launch context as unavailable before a declared reattach',
  async (hookResumeIntent) => {
    harness = await startDaemonAdapterHarness(() => {
      const subprocess = createMockSubprocess()
      subprocesses.push(subprocess)
      return subprocess
    })
    const opts = { cols: 80, rows: 24, sessionId: 'wt@@unknown', cwd: harness.dir }
    const original = await harness.adapter.spawn(opts)
    await expect(harness.adapter.spawn({ ...opts, hookResumeIntent })).rejects.toThrow(
      'agent_resume_intent_unavailable'
    )
    const rows = await harness.adapter.listProcesses()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe(original.id)
    expect(rows[0]?.hookResumeIntent).toBeUndefined()
  }
)
