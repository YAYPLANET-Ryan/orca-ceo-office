import type { HookContextSnapshot } from './hook-context-snapshot'
import { readHookResumeIntent } from '../../../shared/agent-hook-listener/state/hook-resume-intent'
import {
  matchesProviderObservationScope,
  providerObservationScope
} from './provider-observation-scope'

const MAX_MATCHED_PTYS = 4096

type Binding = { scope: string; incarnationId: string; providerSessionId: string }

/** A known request can reject a contradictory report; it never proves clean conversation contents. */
export class RequestedProviderIntentFence {
  private readonly bindings = new Map<string, Binding>()

  reset(): void {
    this.bindings.clear()
  }

  retire(ptyId: string, incarnationId: string | undefined): void {
    if (incarnationId && this.bindings.get(ptyId)?.incarnationId === incarnationId) {
      this.bindings.delete(ptyId)
    }
  }

  check(
    snapshot: HookContextSnapshot,
    agent: unknown,
    providerSessionId: string | undefined,
    eventName: unknown,
    eventSource: unknown,
    replay = false
  ): string | null {
    const intent = snapshot.resumeIntent
    // Unavailable is not fresh or a successful resume; no match receipt is produced.
    if (intent == null) {
      return null
    }
    if (!replay) {
      this.restoreObservedBinding(snapshot)
    }
    if (agent !== intent.agentType) {
      return 'resume_provider_agent_mismatch'
    }
    const asserted = readHookResumeIntent({ agentType: agent, providerSessionId })
    if (!asserted) {
      return 'resume_provider_id_unconfirmed'
    }
    const stored = this.bindings.get(snapshot.ptyId)
    const matched = stored?.scope === this.scope(snapshot) ? stored : undefined
    if (!matched) {
      if (replay) {
        return 'resume_provider_replay_unverified'
      }
      if (!stored && this.bindings.size >= MAX_MATCHED_PTYS) {
        return 'resume_provider_verification_capacity'
      }
      return asserted.providerSessionId === intent.providerSessionId
        ? null
        : 'resume_provider_id_mismatch'
    }
    if (asserted.providerSessionId === matched.providerSessionId) {
      return null
    }
    // Codex has no verified in-process transition contract yet.
    return !replay &&
      agent === 'claude' &&
      eventName === 'SessionStart' &&
      eventSource === 'clear' &&
      asserted.providerSessionId !== intent.providerSessionId
      ? null
      : 'resume_provider_transition_unconfirmed'
  }

  commit(
    snapshot: HookContextSnapshot,
    agent: unknown,
    providerSessionId: string | undefined,
    eventName: unknown,
    eventSource: unknown
  ): void {
    if (
      snapshot.resumeIntent == null ||
      !providerSessionId ||
      this.check(snapshot, agent, providerSessionId, eventName, eventSource) !== null
    ) {
      return
    }
    this.bindings.set(snapshot.ptyId, {
      scope: this.scope(snapshot),
      incarnationId: snapshot.incarnationId,
      providerSessionId
    })
  }

  private scope(snapshot: HookContextSnapshot): string {
    return JSON.stringify([
      snapshot.executionHostId,
      snapshot.paneKey,
      snapshot.worktreeId,
      snapshot.ptyId,
      snapshot.incarnationId,
      snapshot.launchTokenHash,
      snapshot.cwd,
      snapshot.ownerClientInstanceId,
      snapshot.launchCwd,
      snapshot.resumeIntent?.agentType,
      snapshot.resumeIntent?.providerSessionId
    ])
  }

  private restoreObservedBinding(snapshot: HookContextSnapshot): void {
    const intent = snapshot.resumeIntent
    const observation = snapshot.providerObservation
    const current = this.bindings.get(snapshot.ptyId)
    const expected = providerObservationScope(snapshot)
    if (
      !intent ||
      !observation ||
      !expected ||
      current?.scope === this.scope(snapshot) ||
      (!current && this.bindings.size >= MAX_MATCHED_PTYS) ||
      !matchesProviderObservationScope(observation, expected) ||
      observation.originalProviderSessionId !== intent.providerSessionId ||
      observation.agentType !== intent.agentType
    ) {
      return
    }
    this.bindings.set(snapshot.ptyId, {
      scope: this.scope(snapshot),
      incarnationId: snapshot.incarnationId,
      providerSessionId: observation.providerSessionId
    })
  }
}
