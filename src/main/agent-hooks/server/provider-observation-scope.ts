import type { HookContextSnapshot } from './hook-context-snapshot'
import type {
  HookProviderObservation,
  HookProviderObservationScope
} from '../../../shared/agent-hook-listener/state/hook-provider-observation'
import { sameHookProviderObservationScope } from '../../../shared/agent-hook-listener/state/hook-provider-observation-transition'

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
  return sameHookProviderObservationScope(observation, expected)
}
