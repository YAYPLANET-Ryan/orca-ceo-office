import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  IN_PLACE_RESTORE_CLAIM_TTL_MS,
  claimInPlaceRestore,
  hasInPlaceRestoreClaim,
  releaseInPlaceRestore,
  resetInPlaceRestoreClaimsForTests
} from './in-place-restore-claims'

afterEach(() => {
  resetInPlaceRestoreClaimsForTests()
  vi.useRealTimers()
})

describe('in-place restore claims', () => {
  it('holds a claim per pane key until that pane releases it', () => {
    claimInPlaceRestore('tab-1:leaf-a', { now: 1_000 })
    claimInPlaceRestore('tab-1:leaf-b', { now: 1_000 })
    expect(hasInPlaceRestoreClaim('tab-1:leaf-a', 1_500)).toBe(true)
    releaseInPlaceRestore('tab-1:leaf-a')
    expect(hasInPlaceRestoreClaim('tab-1:leaf-a', 1_500)).toBe(false)
    // Why: a split tab's first pane finishing must not expose its sibling's record.
    expect(hasInPlaceRestoreClaim('tab-1:leaf-b', 1_500)).toBe(true)
  })

  it('expires so a mount that never connects does not strand the session', () => {
    claimInPlaceRestore('tab-1:leaf-a', { now: 1_000 })
    expect(hasInPlaceRestoreClaim('tab-1:leaf-a', 1_000 + IN_PLACE_RESTORE_CLAIM_TTL_MS)).toBe(
      false
    )
  })

  it('hands an unreleased claim back through onLapse, but not a released one', () => {
    vi.useFakeTimers()
    const lapsed = vi.fn()
    const released = vi.fn()
    claimInPlaceRestore('tab-1:leaf-a', { onLapse: lapsed })
    claimInPlaceRestore('tab-1:leaf-b', { onLapse: released })
    releaseInPlaceRestore('tab-1:leaf-b')
    vi.advanceTimersByTime(IN_PLACE_RESTORE_CLAIM_TTL_MS + 1)
    expect(lapsed).toHaveBeenCalledTimes(1)
    expect(released).not.toHaveBeenCalled()
    expect(hasInPlaceRestoreClaim('tab-1:leaf-a')).toBe(false)
  })

  it('re-claiming replaces the earlier lapse timer', () => {
    vi.useFakeTimers()
    const first = vi.fn()
    const second = vi.fn()
    claimInPlaceRestore('tab-1:leaf-a', { onLapse: first })
    vi.advanceTimersByTime(IN_PLACE_RESTORE_CLAIM_TTL_MS / 2)
    claimInPlaceRestore('tab-1:leaf-a', { onLapse: second })
    vi.advanceTimersByTime(IN_PLACE_RESTORE_CLAIM_TTL_MS + 1)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
