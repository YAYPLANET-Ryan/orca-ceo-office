import { afterEach, expect, it, vi } from 'vitest'
import { connectWithHelloRetry } from '../daemon-hello-retry'
import { DaemonHelloClosedError } from '../daemon-hello-closed-error'

afterEach(() => vi.useRealTimers())

it('cancels a retry generation deterministically while its backoff is pending', async () => {
  vi.useFakeTimers()
  let current = true
  const connect = vi.fn(async () => {
    throw new DaemonHelloClosedError()
  })
  const result = connectWithHelloRetry({
    timeoutMs: 5000,
    sharedBudget: true,
    connect,
    assertCurrent: () => {
      if (!current) {
        throw new Error('Disconnected')
      }
    }
  }).catch((error: unknown) => error)
  await vi.advanceTimersByTimeAsync(0)
  expect(vi.getTimerCount()).toBe(1)
  current = false
  await vi.advanceTimersByTimeAsync(50)
  expect(await result).toMatchObject({ message: 'Disconnected' })
  expect(connect).toHaveBeenCalledTimes(1)
})
