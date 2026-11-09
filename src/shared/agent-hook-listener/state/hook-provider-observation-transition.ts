import type { HookResumeIntent } from './hook-resume-intent'
import type {
  HookProviderObservation,
  HookProviderObservationScope,
  HookProviderObservationUpdate
} from './hook-provider-observation'

export function sameHookProviderObservationScope(
  left: HookProviderObservationScope,
  right: HookProviderObservationScope
): boolean {
  return (
    left.ptyId === right.ptyId &&
    left.incarnationId === right.incarnationId &&
    left.paneKey === right.paneKey &&
    left.worktreeId === right.worktreeId &&
    left.ownerClientInstanceId === right.ownerClientInstanceId &&
    left.launchTokenHash === right.launchTokenHash &&
    left.launchCwd === right.launchCwd &&
    left.cwd === right.cwd
  )
}

/** Callers must first verify live physical ownership, capability and the canonical scope. */
export function advanceHookProviderObservation(
  previous: HookProviderObservation | undefined,
  update: HookProviderObservationUpdate,
  owner: {
    scope: HookProviderObservationScope
    launchAgent: string | null
    resumeIntent?: HookResumeIntent | null
  }
): HookProviderObservation {
  if (
    !sameHookProviderObservationScope(update, owner.scope) ||
    (owner.launchAgent !== null && owner.launchAgent !== update.agentType) ||
    (owner.resumeIntent && owner.resumeIntent.agentType !== update.agentType) ||
    (previous &&
      (!sameHookProviderObservationScope(previous, owner.scope) ||
        previous.originalProviderSessionId !== owner.resumeIntent?.providerSessionId))
  ) {
    throw new Error('hook_provider_observation_scope_unconfirmed')
  }
  if (previous && previous.agentType !== update.agentType) {
    throw new Error('hook_provider_observation_agent_changed')
  }
  if (previous?.providerSessionId === update.providerSessionId) {
    return previous
  }
  if (update.expectedRevision !== (previous?.revision ?? 0)) {
    throw new Error('hook_provider_observation_revision_changed')
  }
  if (!previous && update.transition !== 'observed') {
    throw new Error('hook_provider_observation_transition_unconfirmed')
  }
  if (
    !previous &&
    owner.resumeIntent &&
    update.providerSessionId !== owner.resumeIntent.providerSessionId
  ) {
    throw new Error('hook_provider_observation_original_unconfirmed')
  }
  if (
    previous &&
    (update.agentType !== 'claude' ||
      update.transition !== 'clear' ||
      update.providerSessionId === previous.originalProviderSessionId)
  ) {
    throw new Error('hook_provider_observation_transition_unconfirmed')
  }
  const revision = (previous?.revision ?? 0) + 1
  if (!Number.isSafeInteger(revision)) {
    throw new Error('hook_provider_observation_capacity')
  }
  const originalProviderSessionId = owner.resumeIntent?.providerSessionId
  const scope = owner.scope
  return Object.freeze({
    version: 1,
    revision,
    ptyId: scope.ptyId,
    incarnationId: scope.incarnationId,
    paneKey: scope.paneKey,
    worktreeId: scope.worktreeId,
    ownerClientInstanceId: scope.ownerClientInstanceId,
    launchTokenHash: scope.launchTokenHash,
    launchCwd: scope.launchCwd,
    cwd: scope.cwd,
    agentType: update.agentType,
    providerSessionId: update.providerSessionId,
    ...(originalProviderSessionId ? { originalProviderSessionId } : {}),
    transition: previous ? 'clear' : originalProviderSessionId ? 'requested-id-matched' : 'observed'
  })
}
