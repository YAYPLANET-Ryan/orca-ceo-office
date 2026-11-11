import {
  agentProviderSessionsEqual,
  extractAgentProviderSession
} from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AdmittedHookContext } from './hook-context-snapshot'
import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { AgentHookServerContextAdmission } from './server-context-admission'

export abstract class AgentHookServerResumeCheckpoints extends AgentHookServerContextAdmission {
  /** Returns the row that is current after the checkpoint, so follow-up work keyed on row
   *  identity (transcript polls, reply retries) does not hold the replaced object. */
  protected checkpointAdmittedProvider(
    source: AgentHookSource,
    context: true | AdmittedHookContext | undefined,
    event: EnrichedAgentHookEventPayload | undefined
  ): EnrichedAgentHookEventPayload | undefined {
    const checkpoint = admittedResumeCheckpoint(
      source,
      context,
      event,
      this.state.lastStatusByPaneKey
    )
    if (checkpoint) {
      this.noteRequestedProviderCommit(source, context, checkpoint)
      if (this.writeLegacyStatusRow(checkpoint)) {
        this.commitStatusRowMutation(event, checkpoint, false)
        this.scheduleStatusPersist()
        return checkpoint
      }
    }
    return event
  }
}

export function admittedResumeCheckpoint(
  source: AgentHookSource,
  context: true | AdmittedHookContext | undefined,
  event: EnrichedAgentHookEventPayload | undefined,
  rows: ReadonlyMap<string, AgentHookEventPayload>
): EnrichedAgentHookEventPayload | null {
  if (!context || context === true || !event || rows.get(event.paneKey) !== event) {
    return null
  }
  const asserted = extractAgentProviderSession(source, context.envelope.hookPayloadRecord)
  if (
    (source !== 'claude' && source !== 'codex') ||
    !asserted ||
    event.toolAgentId ||
    event.providerSessionOnly ||
    event.paneKey !== context.snapshot.paneKey ||
    event.worktreeId !== context.snapshot.worktreeId ||
    event.connectionId !== null ||
    event.payload.agentType !== source ||
    !agentProviderSessionsEqual(source, asserted, event.providerSession)
  ) {
    return null
  }
  return {
    ...event,
    runtimeResumeCheckpoint: true,
    runtimeResumePendingObservation:
      context.envelope.launchToken && event.launchToken === context.envelope.launchToken
        ? undefined
        : event.runtimeResumePendingObservation
  }
}
