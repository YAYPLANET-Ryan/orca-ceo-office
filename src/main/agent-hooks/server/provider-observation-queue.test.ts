import { expect, it, vi } from 'vitest'
import { ProviderObservationQueue } from './provider-observation-queue'
import type {
  HookProviderObservation,
  HookProviderObservationUpdate
} from '../../../shared/agent-hook-listener/state/hook-provider-observation'

const initial: HookProviderObservationUpdate = {
  ptyId: 'pty-a',
  incarnationId: 'generation-a',
  paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
  worktreeId: 'workspace-a',
  ownerClientInstanceId: 'a'.repeat(64),
  launchTokenHash: 'b'.repeat(64),
  launchCwd: '/workspace-a',
  cwd: '/workspace-a',
  expectedRevision: 0,
  agentType: 'claude',
  providerSessionId: 'original',
  transition: 'observed',
  launchToken: 'synthetic-capability'
}

function receipt(update: HookProviderObservationUpdate): HookProviderObservation {
  const { expectedRevision, launchToken: _capability, transition: _transition, ...scope } = update
  return {
    ...scope,
    version: 1,
    revision: expectedRevision + 1,
    originalProviderSessionId: 'original',
    transition: update.providerSessionId === 'original' ? 'requested-id-matched' : 'clear'
  }
}

it('does not report an unsupported writer as a successful observation flush', async () => {
  const queue = new ProviderObservationQueue(vi.fn())
  queue.enqueue(initial)
  expect(await queue.flush()).toBe(false)
})

it('serializes original and clear acknowledgements without deriving revisions from hook order', async () => {
  const queue = new ProviderObservationQueue(vi.fn())
  const written: HookProviderObservationUpdate[] = []
  queue.setWriter(async (update) => {
    await Promise.resolve()
    written.push(update)
    return receipt(update)
  })
  queue.enqueue(initial)
  queue.enqueue({ ...initial, providerSessionId: 'cleared', transition: 'clear' })
  expect(await queue.flush()).toBe(true)
  expect(written.map((update) => [update.providerSessionId, update.expectedRevision])).toEqual([
    ['original', 0],
    ['cleared', 1]
  ])
})

it('keeps the acknowledged revision when a later clear commits with an older admission snapshot', async () => {
  const queue = new ProviderObservationQueue(vi.fn())
  const revisions: number[] = []
  queue.setWriter(async (update) => {
    revisions.push(update.expectedRevision)
    return receipt(update)
  })
  queue.enqueue(initial)
  expect(await queue.flush()).toBe(true)
  queue.enqueue({ ...initial, providerSessionId: 'cleared', transition: 'clear' })
  expect(await queue.flush()).toBe(true)
  expect(revisions).toEqual([0, 1])
})

it('keeps a failed original ahead of clear and retries only when explicitly requested', async () => {
  const unavailable = vi.fn()
  const queue = new ProviderObservationQueue(unavailable)
  let blocked = true
  const written: string[] = []
  queue.setWriter(async (update) => {
    if (blocked) {
      throw new Error('synthetic host unavailable')
    }
    written.push(update.providerSessionId)
    return receipt(update)
  })
  queue.enqueue(initial)
  queue.enqueue({ ...initial, providerSessionId: 'cleared', transition: 'clear' })
  expect(await queue.flush()).toBe(false)
  expect(written).toEqual([])
  blocked = false
  expect(await queue.flush()).toBe(true)
  expect(written).toEqual(['original', 'cleared'])
})

it('holds a contradictory generation without retrying or accumulating later transitions', async () => {
  const unavailable = vi.fn()
  const queue = new ProviderObservationQueue(unavailable)
  const writer = vi.fn(async () => {
    throw new Error('hook_provider_observation_original_unconfirmed')
  })
  queue.setWriter(writer)
  queue.enqueue(initial)
  expect(await queue.flush()).toBe(false)
  for (let index = 0; index < 100; index++) {
    queue.enqueue({ ...initial, providerSessionId: `clear-${index}`, transition: 'clear' })
  }
  expect(await queue.flush()).toBe(false)
  queue.retire(initial.ptyId, initial.incarnationId)
  expect(await queue.flush()).toBe(true)
})

it.each(['scope', 'provider', 'revision', 'unsupported'])(
  'never drains a pending observation on an unconfirmed %s response',
  async (fault) => {
    const queue = new ProviderObservationQueue(vi.fn())
    queue.setWriter(async (update) => {
      const valid = receipt(update)
      if (fault === 'scope') {
        return { ...valid, incarnationId: 'foreign-generation' }
      }
      if (fault === 'provider') {
        return { ...valid, providerSessionId: 'foreign-conversation' }
      }
      if (fault === 'revision') {
        return { ...valid, revision: 5 }
      }
      return null
    })
    queue.enqueue(initial)
    expect(await queue.flush()).toBe(false)
  }
)

it('uses the actual idempotent acknowledgement revision instead of assuming an increment', async () => {
  const queue = new ProviderObservationQueue(vi.fn())
  const revisions: number[] = []
  queue.setWriter(async (update) => {
    revisions.push(update.expectedRevision)
    return { ...receipt(update), revision: update.providerSessionId === 'original' ? 1 : 2 }
  })
  queue.enqueue({ ...initial, expectedRevision: 1 })
  queue.enqueue({
    ...initial,
    expectedRevision: 1,
    providerSessionId: 'cleared',
    transition: 'clear'
  })
  expect(await queue.flush()).toBe(true)
  expect(revisions).toEqual([1, 1])
})

it('retires pending capabilities only on the exact physical exit, including an in-flight response', async () => {
  const queue = new ProviderObservationQueue(vi.fn())
  let complete!: (value: HookProviderObservation) => void
  queue.setWriter(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  queue.enqueue(initial)
  queue.retire(initial.ptyId, 'foreign-generation')
  queue.retire(initial.ptyId, undefined)
  queue.retire(initial.ptyId, initial.incarnationId)
  complete(receipt(initial))
  expect(await queue.flush()).toBe(true)
})

it('reports overflow without evicting pending transitions or claiming a successful flush', async () => {
  const unavailable = vi.fn()
  const queue = new ProviderObservationQueue(unavailable)
  let complete!: (value: HookProviderObservation) => void
  queue.setWriter(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  queue.enqueue(initial)
  for (let index = 1; index <= 64; index++) {
    queue.enqueue({ ...initial, providerSessionId: `clear-${index}`, transition: 'clear' })
  }
  queue.retire(initial.ptyId, initial.incarnationId)
  complete(receipt(initial))
  expect(await queue.flush()).toBe(false)
})

it('cannot retire a pending generation using a missing or foreign exit incarnation', async () => {
  const queue = new ProviderObservationQueue(vi.fn())
  queue.setWriter(async () => null)
  queue.enqueue(initial)
  expect(await queue.flush()).toBe(false)
  queue.retire(initial.ptyId, 'foreign-generation')
  queue.retire(initial.ptyId, undefined)
  expect(await queue.flush()).toBe(false)
  queue.retire(initial.ptyId, initial.incarnationId)
  expect(await queue.flush()).toBe(true)
})
