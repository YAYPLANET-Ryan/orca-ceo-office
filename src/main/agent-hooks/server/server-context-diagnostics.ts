import { AgentHookAttributionDiagnostics } from '../../../shared/agent-hook-listener/state/agent-hook-attribution-diagnostics'
import type {
  HookContextQuarantineSnapshot,
  HookContextIntegritySummary
} from '../../../shared/agent-hook-listener/state/hook-context-quarantine-types'
import { hookContextClaimFingerprint } from '../hook-context-quarantine'
import { normalizeHookContextReason } from '../../../shared/agent-hook-listener/state/hook-context-quarantine-types'
import { AgentHookServerTmuxStatus } from './server-tmux-status'

export abstract class AgentHookServerContextDiagnostics extends AgentHookServerTmuxStatus {
  protected abstract hasContextVerificationReaders(): boolean
  protected readonly attributionDiagnostics = new AgentHookAttributionDiagnostics()
  private readonly contextIntegrityRejections = new Map<string, number>()

  protected resetContextIntegrityRejections(): void {
    this.contextIntegrityRejections.clear()
  }

  getContextIntegrityRejections(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.contextIntegrityRejections)
  }

  getContextQuarantineSnapshot(): HookContextQuarantineSnapshot {
    return this.contextQuarantine.snapshot()
  }

  getContextIntegritySummary(): HookContextIntegritySummary {
    const snapshot = this.contextQuarantine.snapshot()
    return {
      version: 1,
      unverifiedCount: snapshot.entries.reduce(
        (total, entry) => Math.min(Number.MAX_SAFE_INTEGER, total + entry.count),
        0
      ),
      overflowCount: snapshot.overflowCount,
      durability: snapshot.durability,
      verification:
        this.server &&
        this.port > 0 &&
        this.statusHooksEnabled &&
        this.contextQuarantine.isOpen() &&
        this.hasContextVerificationReaders()
          ? 'available'
          : 'unavailable'
    }
  }

  subscribeContextQuarantine(
    listener: (snapshot: HookContextQuarantineSnapshot) => void
  ): () => void {
    return this.contextQuarantine.subscribe(listener)
  }

  protected refuseUnverifiedContext(
    reason: string,
    claim?: {
      paneKey?: string
      worktreeId?: string
      providerSessionId?: string
    }
  ): false {
    reason = normalizeHookContextReason(reason)
    this.contextQuarantine.record(reason, claim ? hookContextClaimFingerprint(claim) : undefined)
    this.contextIntegrityRejections.set(
      reason,
      (this.contextIntegrityRejections.get(reason) ?? 0) + 1
    )
    if (this.attributionDiagnostics.shouldReport('context_integrity_unverified')) {
      console.warn(
        '[agent-hooks] Context identity unconfirmed; automatic association blocked:',
        reason
      )
    }
    return false
  }
}
