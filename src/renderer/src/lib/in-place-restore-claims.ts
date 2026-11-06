/**
 * Short-lived ownership claims for panes that the background wake mounted so
 * they cold-restore their own sleeping record in place.
 *
 * Why: between the mount request and the pane's connect, the pane has no live
 * PTY, so the resume sweep (including the mirror-parked replay that drops
 * skipClaimKeys) would judge the record unowned and fork it into a fresh tab.
 * The claim is keyed by the record's stable pane key (one per pane, so a split
 * tab's panes release independently). Lifecycle:
 *  - the pane marks the claim in flight when it starts its resume spawn; an
 *    in-flight claim never lapses (a late-but-successful spawn must not be
 *    raced by a replacement resume) — the pane itself ends it;
 *  - the pane releases it when the spawn consumed the record;
 *  - the pane lapses it (onLapse runs the recovery sweep at once) when no
 *    resume could be prepared or the spawn yielded no PTY;
 *  - a claim neither in flight nor ended by the TTL lapses on its own, so a
 *    mount that never connects does not strand the session.
 */
type InPlaceRestoreClaim = {
  expiresAt: number
  inFlight: boolean
  onLapse: (() => void) | null
  timer: ReturnType<typeof setTimeout> | null
}

const claims = new Map<string, InPlaceRestoreClaim>()

export const IN_PLACE_RESTORE_CLAIM_TTL_MS = 90_000

function armLapseTimer(paneKey: string, claim: InPlaceRestoreClaim): void {
  if (claim.timer) {
    clearTimeout(claim.timer)
  }
  const scheduled = setTimeout(() => {
    const current = claims.get(paneKey)
    if (!current || current.timer !== scheduled) {
      return
    }
    if (current.inFlight) {
      // Why: the pane is mid-spawn; it will release or lapse the claim itself.
      // Keep the record owned meanwhile instead of forking it.
      current.expiresAt = Date.now() + IN_PLACE_RESTORE_CLAIM_TTL_MS
      armLapseTimer(paneKey, current)
      return
    }
    lapseInPlaceRestore(paneKey)
  }, IN_PLACE_RESTORE_CLAIM_TTL_MS)
  ;(scheduled as { unref?: () => void }).unref?.()
  claim.timer = scheduled
}

export function claimInPlaceRestore(
  paneKey: string,
  options: { now?: number; onLapse?: () => void } = {}
): void {
  releaseInPlaceRestore(paneKey)
  const claim: InPlaceRestoreClaim = {
    expiresAt: (options.now ?? Date.now()) + IN_PLACE_RESTORE_CLAIM_TTL_MS,
    inFlight: false,
    onLapse: options.onLapse ?? null,
    timer: null
  }
  claims.set(paneKey, claim)
  if (claim.onLapse) {
    armLapseTimer(paneKey, claim)
  }
}

/** The pane has started the spawn that consumes its record. */
export function markInPlaceRestoreInFlight(paneKey: string): void {
  const claim = claims.get(paneKey)
  if (claim) {
    claim.inFlight = true
  }
}

/** The pane consumed its record: drop the claim quietly. */
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

/** The pane could not restore (no resume prepared, spawn without a PTY) or the
 * TTL passed: drop the claim and hand the record back to the recovery sweep. */
export function lapseInPlaceRestore(paneKey: string): void {
  const claim = claims.get(paneKey)
  if (!claim) {
    return
  }
  releaseInPlaceRestore(paneKey)
  claim.onLapse?.()
}

export function hasInPlaceRestoreClaim(paneKey: string, now = Date.now()): boolean {
  const claim = claims.get(paneKey)
  if (!claim) {
    return false
  }
  if (claim.expiresAt <= now) {
    if (claim.inFlight) {
      claim.expiresAt = now + IN_PLACE_RESTORE_CLAIM_TTL_MS
      return true
    }
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
