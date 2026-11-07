import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { agentProviderSessionsEqual } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { EnrichedAgentHookEventPayload } from './server-types'

export function retainResumeCheckpoint(
  previous: EnrichedAgentHookEventPayload | undefined,
  incoming: AgentHookEventPayload
): { runtimeResumeCheckpoint?: true } {
  return previous?.runtimeResumeCheckpoint &&
    previous.payload.agentType === incoming.payload.agentType &&
    incoming.payload.agentType &&
    agentProviderSessionsEqual(
      incoming.payload.agentType,
      previous.providerSession,
      incoming.providerSession
    )
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
