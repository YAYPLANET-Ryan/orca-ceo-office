import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { agentProviderSessionsEqual } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentStatusObservationOrigin } from '../../../shared/agent-status/contracts/agent-status-observation'

export function retainResumeCheckpoint(
  previous: EnrichedAgentHookEventPayload | undefined,
  incoming: AgentHookEventPayload,
  _origin?: AgentStatusObservationOrigin
): { runtimeResumeCheckpoint?: true } {
  return previous?.runtimeResumeCheckpoint &&
    previous.payload.agentType === incoming.payload.agentType &&
    incoming.payload.agentType &&
    previous.runtimeResumePendingObservation !== true &&
    previous.paneKey === incoming.paneKey &&
    previous.connectionId === incoming.connectionId &&
    previous.worktreeId === incoming.worktreeId &&
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
  const { launchToken: _launchToken, ...identity } = entry
  return { ...identity, providerSessionOnly: true, retainedForLiveness: true }
}
