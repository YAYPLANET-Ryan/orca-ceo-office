import type { LaunchResumeIdentityEvent } from './launch-resume-identity-event'
import { MAX_PANE_KEY_LEN } from '../../../shared/agent-hook-listener/listener-limits'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { agentProviderSessionsEqual } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { EnrichedAgentHookEventPayload } from './server-types'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import { AgentHookServerIngestNormalization } from './server-ingest-normalization'

export abstract class AgentHookServerLaunchResumeIdentity extends AgentHookServerIngestNormalization {
  /** Requested IDs remain unverified metadata until the provider proves its current ownership. */
  recordLaunchResumeIdentity(
    event: LaunchResumeIdentityEvent
  ): 'recorded' | 'seeded' | 'deduped' | 'refused' {
    if (event.agentType === 'claude' || event.agentType === 'codex') {
      // History keeps the exact requested pane; aliases are not ownership evidence.
      if (
        event.paneKey !== event.paneKey.trim() ||
        (event.worktreeId !== undefined && event.worktreeId !== event.worktreeId.trim())
      ) {
        return 'refused'
      }
      const recorded =
        this.resumeRecipeJournalBindingValid && this.resumeRecipeJournal?.record(event)
      this.refuseUnverifiedContext('launch_context_attestation_unavailable', {
        paneKey: event.paneKey,
        worktreeId: event.worktreeId,
        providerSessionId: event.providerSession.id
      })
      return recorded ? 'recorded' : 'refused'
    }
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

  getUnverifiedResumeLaunchRecipesForPane(paneKey: string, worktreeId?: string) {
    if (!this.resumeRecipeJournalBindingValid || !this.resumeRecipeJournal) {
      return {
        unavailable: true,
        pending: this.resumeRecipeJournal?.hasPending ?? false,
        recipes: []
      }
    }
    const snapshot = this.resumeRecipeJournal.snapshot(paneKey)
    return {
      ...snapshot,
      recipes: snapshot.recipes.filter((recipe) => recipe.worktreeId === worktreeId)
    }
  }
}
