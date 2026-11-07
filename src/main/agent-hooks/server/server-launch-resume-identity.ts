import type { LaunchResumeIdentityEvent } from './launch-resume-identity-event'
import { MAX_PANE_KEY_LEN } from '../../../shared/agent-hook-listener/listener-limits'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { agentProviderSessionsEqual } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { AgentHookServerIngestNormalization } from './server-ingest-normalization'

export abstract class AgentHookServerLaunchResumeIdentity extends AgentHookServerIngestNormalization {
  /** Seed resume identity before the first hook; Codex SessionStart waits for the first turn (#10923). */
  recordLaunchResumeIdentity(event: LaunchResumeIdentityEvent): 'seeded' | 'deduped' | 'refused' {
    const paneKey = this.resolvePaneKeyAlias(event.paneKey.trim())
    const parsedPaneKey = parsePaneKey(paneKey)
    if (!parsedPaneKey || paneKey.length > MAX_PANE_KEY_LEN) {
      return 'refused'
    }
    const previous = this.state.lastStatusByPaneKey.get(paneKey)
    const sameIdentity =
      previous?.payload.agentType === event.agentType &&
      agentProviderSessionsEqual(event.agentType, previous.providerSession, event.providerSession)
    const currentLaunch =
      previous &&
      'observation' in previous &&
      previous.observation &&
      typeof previous.observation === 'object' &&
      'origin' in previous.observation &&
      previous.observation.origin === 'launch' &&
      'runtimeResumePendingObservation' in previous &&
      previous.runtimeResumePendingObservation === true
    if (
      previous &&
      (previous.providerSessionOnly === true
        ? sameIdentity && currentLaunch && previous.agentPresence?.ended !== true
        : 'receivedAt' in previous &&
          typeof previous.receivedAt === 'number' &&
          previous.receivedAt >= event.launchedAt)
    ) {
      if (
        sameIdentity &&
        !previous.providerSessionOnly &&
        'receivedAt' in previous &&
        typeof previous.receivedAt === 'number' &&
        'stateStartedAt' in previous &&
        typeof previous.stateStartedAt === 'number'
      ) {
        if (
          !this.writeLegacyStatusRow({
            ...previous,
            receivedAt: previous.receivedAt,
            stateStartedAt: previous.stateStartedAt,
            runtimeResumeCheckpoint: true
          })
        ) {
          return 'refused'
        }
        this.scheduleStatusPersist()
      }
      return sameIdentity ? 'deduped' : 'refused'
    }
    const identity: AgentHookEventPayload &
      Pick<
        EnrichedAgentHookEventPayload,
        'retainedForLiveness' | 'runtimeResumeCheckpoint' | 'runtimeResumePendingObservation'
      > = {
      paneKey,
      tabId: parsedPaneKey.tabId,
      ...(event.worktreeId?.trim() ? { worktreeId: event.worktreeId.trim() } : {}),
      connectionId: null,
      providerSession: event.providerSession,
      providerSessionOnly: true,
      // Hydration must retain this identity even if no first turn occurs before restart.
      retainedForLiveness: true,
      runtimeResumeCheckpoint: true,
      runtimeResumePendingObservation: true,
      payload: { state: 'done', prompt: '', agentType: event.agentType }
    }
    return this.applyNormalizedStatus(identity, undefined, 'launch') ? 'seeded' : 'refused'
  }
}
