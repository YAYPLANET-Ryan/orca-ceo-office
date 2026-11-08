import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { agentProviderSessionsEqual } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentStatusObservationOrigin } from '../../../shared/agent-status/contracts/agent-status-observation'
import { sameAgentStatusTerminalOwner } from '../../../shared/agent-status/identity/agent-status-terminal-owner'

export function retainResumeCheckpoint(
  previous: EnrichedAgentHookEventPayload | undefined,
  incoming: AgentHookEventPayload,
  origin?: AgentStatusObservationOrigin
): { runtimeResumeCheckpoint?: true } {
  return previous?.runtimeResumeCheckpoint &&
    previous.payload.agentType === incoming.payload.agentType &&
    incoming.payload.agentType &&
    (agentProviderSessionsEqual(
      incoming.payload.agentType,
      previous.providerSession,
      incoming.providerSession
    ) ||
      (origin === 'hook' &&
        previous.agentPresence?.ended !== true &&
        (!previous.providerSessionOnly || previous.observation?.origin === 'launch') &&
        sameAgentStatusTerminalOwner(previous, incoming) &&
        incoming.providerSession))
    ? { runtimeResumeCheckpoint: true }
    : {}
}

export function retainedResumeIdentity(
  entry: EnrichedAgentHookEventPayload | null | undefined
): EnrichedAgentHookEventPayload | null {
  if (
    !entry?.providerSession ||
    !entry.payload.agentType ||
    entry.payload.agentType === 'unknown'
  ) {
    return null
  }
  const {
    launchToken: _launchToken,
    runtimeResumePendingObservation: _pending,
    ...identity
  } = entry
  return { ...identity, providerSessionOnly: true, retainedForLiveness: true }
}
