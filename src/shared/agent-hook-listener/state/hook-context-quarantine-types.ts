/** Diagnostic quarantine is never an ownership, resume or context-cleanliness receipt. */
const CONTEXT_REFUSAL_REASONS = [
  'invalid_context_reason',
  'unattested_source_targets_protected_pane',
  'context_reader_unavailable',
  'invalid_context_claim',
  'foreign_execution_host',
  'workspace_cwd_unconfirmed',
  'launch_generation_unconfirmed',
  'process_generation_unconfirmed',
  'context_changed_during_verification',
  'hook_transport_caller_changed',
  'agent_exited_during_context_verification',
  'provider_owned_by_another_pane',
  'context_admission_queue_unavailable',
  'context_evidence_unavailable',
  'context_changed_before_commit',
  'normalized_provider_owned_by_another_pane',
  'remote_context_attestation_unavailable',
  'launch_context_attestation_unavailable',
  'resume_recipe_storage_unavailable',
  'resume_recipe_capacity_exceeded',
  'terminal_context_attestation_unavailable',
  'auxiliary_context_attestation_unavailable'
] as const
export type HookContextRefusalReason = (typeof CONTEXT_REFUSAL_REASONS)[number]
const REASONS = new Map<string, HookContextRefusalReason>(
  CONTEXT_REFUSAL_REASONS.map((reason) => [reason, reason])
)
export function normalizeHookContextReason(reason: unknown): HookContextRefusalReason {
  return REASONS.get(typeof reason === 'string' ? reason : '') ?? 'invalid_context_reason'
}

export type HookContextQuarantineEntry = {
  reason: string
  fingerprint?: string
  firstSeenAt: number
  lastSeenAt: number
  count: number
}

export type HookContextQuarantineSnapshot = {
  version: 1
  entries: readonly HookContextQuarantineEntry[]
  overflowCount: number
  durability: 'memory-only' | 'pending' | 'saved' | 'unavailable'
}

/** Host health only; do not send quarantine fingerprints or pane/session identifiers to clients. */
export type HookContextIntegritySummary = {
  version: 1
  unverifiedCount: number
  overflowCount: number
  durability: HookContextQuarantineSnapshot['durability']
  /** Listener/readers are configured and callable; never proof a conversation is clean. */
  verification: 'available' | 'unavailable'
}

export function readHookContextIntegritySummary(
  value: unknown
): HookContextIntegritySummary | null {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('unverifiedCount' in value) ||
    typeof value.unverifiedCount !== 'number' ||
    !Number.isSafeInteger(value.unverifiedCount) ||
    value.unverifiedCount < 0 ||
    !('overflowCount' in value) ||
    typeof value.overflowCount !== 'number' ||
    !Number.isSafeInteger(value.overflowCount) ||
    value.overflowCount < 0 ||
    !('durability' in value) ||
    (value.durability !== 'memory-only' &&
      value.durability !== 'pending' &&
      value.durability !== 'saved' &&
      value.durability !== 'unavailable') ||
    !('verification' in value) ||
    (value.verification !== 'available' && value.verification !== 'unavailable')
  ) {
    return null
  }
  return {
    version: 1,
    unverifiedCount: value.unverifiedCount,
    overflowCount: value.overflowCount,
    durability: value.durability,
    verification: value.verification
  }
}
