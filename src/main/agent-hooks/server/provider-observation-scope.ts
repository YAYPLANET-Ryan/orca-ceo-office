import type { HookContextSnapshot } from './hook-context-snapshot'
import type {
  HookProviderObservation,
  HookProviderObservationScope
} from '../../../shared/agent-hook-listener/state/hook-provider-observation'

export function providerObservationScope(
  snapshot: HookContextSnapshot
): HookProviderObservationScope | undefined {
  if (!snapshot.ownerClientInstanceId || !snapshot.launchCwd) {
    return undefined
  }
  return {
    ptyId: snapshot.ptyId,
    incarnationId: snapshot.incarnationId,
    paneKey: snapshot.paneKey,
    worktreeId: snapshot.worktreeId,
    ownerClientInstanceId: snapshot.ownerClientInstanceId,
    launchTokenHash: snapshot.launchTokenHash,
    launchCwd: snapshot.launchCwd,
    cwd: snapshot.cwd
  }
}

export function matchesProviderObservationScope(
  observation: HookProviderObservation,
  expected: HookProviderObservationScope
): boolean {
  return (
    observation.ptyId === expected.ptyId &&
    observation.incarnationId === expected.incarnationId &&
    observation.paneKey === expected.paneKey &&
    observation.worktreeId === expected.worktreeId &&
    observation.ownerClientInstanceId === expected.ownerClientInstanceId &&
    observation.launchTokenHash === expected.launchTokenHash &&
    observation.launchCwd === expected.launchCwd &&
    observation.cwd === expected.cwd
  )
}
