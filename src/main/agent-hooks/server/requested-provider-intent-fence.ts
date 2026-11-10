import type { HookContextSnapshot } from './hook-context-snapshot'
import { readHookResumeIntent } from '../../../shared/agent-hook-listener/state/hook-resume-intent'
import {
  matchesProviderObservationScope,
  providerObservationScope
} from './provider-observation-scope'

const MAX_MATCHED_PTYS = 4096

type Binding = {
  scope: string
  incarnationId: string
  providerSessionId: string
  // Admitted agent process that reported the bound ID; absent on bindings restored from an observation.
  processKey?: string
}

/** Hook facts beyond the scope that a Codex in-process clear must carry to replace the bound ID. */
export type RequestedProviderTransitionEvidence = {
  processKey?: string
  transcriptPath?: unknown
  agentId?: unknown
}

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
    replay = false,
    evidence: RequestedProviderTransitionEvidence = {}
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
    const cleared =
      !replay &&
      eventName === 'SessionStart' &&
      eventSource === 'clear' &&
      asserted.providerSessionId !== intent.providerSessionId
    if (cleared && agent === 'claude') {
      return null
    }
    // Codex /clear starts a new root thread in the same process: require that exact admitted process,
    // a persisted transcript (hidden threads have none) and no subagent identity.
    const codexInProcessClear =
      cleared &&
      agent === 'codex' &&
      evidence.processKey !== undefined &&
      matched.processKey === evidence.processKey &&
      typeof evidence.transcriptPath === 'string' &&
      evidence.transcriptPath.length > 0 &&
      evidence.agentId === undefined
    return codexInProcessClear ? null : 'resume_provider_transition_unconfirmed'
  }

  commit(
    snapshot: HookContextSnapshot,
    agent: unknown,
    providerSessionId: string | undefined,
    eventName: unknown,
    eventSource: unknown,
    evidence: RequestedProviderTransitionEvidence = {}
  ): void {
    if (
      snapshot.resumeIntent == null ||
      !providerSessionId ||
      this.check(snapshot, agent, providerSessionId, eventName, eventSource, false, evidence) !==
        null
    ) {
      return
    }
    this.bindings.set(snapshot.ptyId, {
      scope: this.scope(snapshot),
      incarnationId: snapshot.incarnationId,
      providerSessionId,
      ...(evidence.processKey !== undefined ? { processKey: evidence.processKey } : {})
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
