import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  beginProviderObservationQuitDrain,
  createProviderObservationQuitStop,
  saveAfterProviderObservationQuitStop
} from './provider-observation-quit-drain'
import { OrcadRuntimeLifetime } from '../orcad/orcad-runtime-lifetime'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('leaves the synchronous quit path available when there are no pending observations', () => {
  expect(
    beginProviderObservationQuitDrain({
      hasPendingProviderObservations: false,
      flushProviderObservations: async () => {
        throw new Error('Unexpected flush')
      }
    })
  ).toBeNull()
})

it('acknowledges only after the pending host write completes', async () => {
  const host = Promise.withResolvers<boolean>()
  const drain = beginProviderObservationQuitDrain({
    hasPendingProviderObservations: true,
    flushProviderObservations: () => host.promise
  })
  let completed = false
  void drain?.then(() => {
    completed = true
  })
  await vi.advanceTimersByTimeAsync(0)
  expect(completed).toBe(false)
  host.resolve(true)
  expect(await drain).toBe(true)
})

it.each(['refused', 'exception', 'unreachable'])(
  'keeps %s distinct from an acknowledged checkpoint without hanging quit',
  async (failure) => {
    const drain = beginProviderObservationQuitDrain({
      hasPendingProviderObservations: true,
      flushProviderObservations: () => {
        if (failure === 'exception') {
          throw new Error('Synthetic failure')
        }
        return failure === 'refused' ? Promise.resolve(false) : new Promise<boolean>(() => {})
      }
    })
    await vi.runAllTimersAsync()
    expect(await drain).toBe(false)
  }
)

it('quiesces headless ingress before final save and detaches last in reverse cleanup order', async () => {
  const host = Promise.withResolvers<boolean>()
  const effects = { ingress: true, attached: true, saved: false, released: false }
  const stop = createProviderObservationQuitStop({
    stop: () => {
      if (!effects.ingress) {
        throw new Error('Duplicate stop')
      }
      effects.ingress = false
    },
    hasPendingProviderObservations: true,
    flushProviderObservations: () => host.promise
  })
  const lifetime = new OrcadRuntimeLifetime(() => {
    effects.released = true
  })
  lifetime.add(() => {
    effects.attached = false
  })
  lifetime.add(() =>
    saveAfterProviderObservationQuitStop(stop, async () => {
      effects.saved = true
    })
  )
  const closing = lifetime.stop()
  await vi.advanceTimersByTimeAsync(0)
  expect(effects).toEqual({ ingress: false, attached: true, saved: false, released: false })
  host.resolve(true)
  await closing
  expect(effects).toEqual({ ingress: false, attached: false, saved: true, released: true })
})

it('attempts final save after a cached stop failure while retaining profile ownership', async () => {
  const effects = { attached: true, saved: false, released: false, observationAttempted: false }
  const stopFailure = new Error('Synthetic stop failure')
  const stop = createProviderObservationQuitStop({
    stop: () => {
      throw stopFailure
    },
    hasPendingProviderObservations: true,
    flushProviderObservations: async () => {
      effects.observationAttempted = true
      return true
    }
  })
  const lifetime = new OrcadRuntimeLifetime(() => {
    effects.released = true
  })
  lifetime.add(() => {
    effects.attached = false
  })
  lifetime.add(() =>
    saveAfterProviderObservationQuitStop(stop, async () => {
      effects.saved = true
    })
  )
  expect(stop()).toBe(stop())
  await expect(lifetime.stop()).rejects.toBe(stopFailure)
  expect(effects).toEqual({
    attached: false,
    saved: true,
    released: false,
    observationAttempted: true
  })
})

it('retains both stop and final-save failures instead of replacing either outcome', async () => {
  const failure = saveAfterProviderObservationQuitStop(
    async () => {
      throw new Error('Synthetic stop failure')
    },
    async () => {
      throw new Error('Synthetic save failure')
    }
  )
  await expect(failure).rejects.toMatchObject({
    message: 'hook_observation_stop_and_final_save_failed',
    errors: [new Error('Synthetic stop failure'), new Error('Synthetic save failure')]
  })
})
