/**
 * Short-lived ownership claims for panes that the background wake mounted so
 * they cold-restore their own sleeping record in place.
 *
 * Why: between the mount request and the pane's connect, the pane has no live
 * PTY, so the resume sweep (including the mirror-parked replay that drops
 * skipClaimKeys) would judge the record unowned and fork it into a fresh tab.
 * The claim keeps the record pane-owned for a bounded time; the pane releases
 * it when it consumes or declines the record, and expiry is the fallback when
 * the mount never connects, so the sweep can still recover the session.
 */
const claims = new Map<string, number>()

export const IN_PLACE_RESTORE_CLAIM_TTL_MS = 90_000

export function claimInPlaceRestore(tabId: string, now = Date.now()): void {
  claims.set(tabId, now + IN_PLACE_RESTORE_CLAIM_TTL_MS)
}

export function releaseInPlaceRestore(tabId: string): void {
  claims.delete(tabId)
}

export function hasInPlaceRestoreClaim(tabId: string, now = Date.now()): boolean {
  const expiresAt = claims.get(tabId)
  if (expiresAt === undefined) {
    return false
  }
  if (expiresAt <= now) {
    claims.delete(tabId)
    return false
  }
  return true
}

export function resetInPlaceRestoreClaimsForTests(): void {
  claims.clear()
}
