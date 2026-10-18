/**
 * Short-lived ownership claims for panes that the background wake mounted so
 * they cold-restore their own sleeping record in place.
 *
 * Why: between the mount request and the pane's connect, the pane has no live
 * PTY, so the resume sweep (including the mirror-parked replay that drops
 * skipClaimKeys) would judge the record unowned and fork it into a fresh tab.
 * The claim is keyed by the record's stable pane key (one per pane, so a split
 * tab's panes release independently); the pane releases it when it consumes or
 * declines the record, or when its spawn fails. A claim nobody released by the
 * TTL lapses and hands the record back to the sweep (`onLapse`), so a mount
 * that never connects does not strand the session.
 */
type InPlaceRestoreClaim = {
  expiresAt: number
  timer: ReturnType<typeof setTimeout> | null
}

const claims = new Map<string, InPlaceRestoreClaim>()

export const IN_PLACE_RESTORE_CLAIM_TTL_MS = 90_000

export function claimInPlaceRestore(
  paneKey: string,
  options: { now?: number; onLapse?: () => void } = {}
): void {
  releaseInPlaceRestore(paneKey)
  const now = options.now ?? Date.now()
  const onLapse = options.onLapse
  let timer: ReturnType<typeof setTimeout> | null = null
  if (onLapse) {
    const scheduled = setTimeout(() => {
      // Why: still held at the TTL means the mounted pane never reached its cold
      // restore; drop the claim first so the retry sweep sees the record unowned.
      if (claims.get(paneKey)?.timer === scheduled) {
        claims.delete(paneKey)
        onLapse()
      }
    }, IN_PLACE_RESTORE_CLAIM_TTL_MS)
    ;(scheduled as { unref?: () => void }).unref?.()
    timer = scheduled
  }
  claims.set(paneKey, { expiresAt: now + IN_PLACE_RESTORE_CLAIM_TTL_MS, timer })
}

export function releaseInPlaceRestore(paneKey: string): void {
  const claim = claims.get(paneKey)
  if (!claim) {
    return
  }
  if (claim.timer) {
    clearTimeout(claim.timer)
  }
  claims.delete(paneKey)
}

export function hasInPlaceRestoreClaim(paneKey: string, now = Date.now()): boolean {
  const claim = claims.get(paneKey)
  if (!claim) {
    return false
  }
  if (claim.expiresAt <= now) {
    // Why: the asking sweep recovers the record itself; no lapse retry needed.
    releaseInPlaceRestore(paneKey)
    return false
  }
  return true
}

export function resetInPlaceRestoreClaimsForTests(): void {
  for (const claim of claims.values()) {
    if (claim.timer) {
      clearTimeout(claim.timer)
    }
  }
  claims.clear()
}
