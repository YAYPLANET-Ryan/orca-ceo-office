import { afterEach, describe, expect, it } from 'vitest'
import {
  IN_PLACE_RESTORE_CLAIM_TTL_MS,
  claimInPlaceRestore,
  hasInPlaceRestoreClaim,
  releaseInPlaceRestore,
  resetInPlaceRestoreClaimsForTests
} from './in-place-restore-claims'

afterEach(() => resetInPlaceRestoreClaimsForTests())

describe('in-place restore claims', () => {
  it('holds a claim until release', () => {
    claimInPlaceRestore('tab-1', 1_000)
    expect(hasInPlaceRestoreClaim('tab-1', 1_500)).toBe(true)
    releaseInPlaceRestore('tab-1')
    expect(hasInPlaceRestoreClaim('tab-1', 1_500)).toBe(false)
  })

  it('expires so a mount that never connects does not strand the session', () => {
    claimInPlaceRestore('tab-1', 1_000)
    expect(hasInPlaceRestoreClaim('tab-1', 1_000 + IN_PLACE_RESTORE_CLAIM_TTL_MS)).toBe(false)
  })
})
