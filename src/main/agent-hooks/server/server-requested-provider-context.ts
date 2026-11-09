import { AgentHookServerContextDiagnostics } from './server-context-diagnostics'
import { RequestedProviderIntentFence } from './requested-provider-intent-fence'
import type { HookContextSnapshot, AdmittedHookContext } from './hook-context-snapshot'
import type { EnrichedAgentHookEventPayload, NormalizedLocalHook } from './server-types'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'

export abstract class AgentHookServerRequestedProviderContext extends AgentHookServerContextDiagnostics {
  protected readonly requestedProviderIntents = new RequestedProviderIntentFence()
  retireRequestedProviderIntent(ptyId: string, incarnationId: string | undefined): void {
    this.requestedProviderIntents.retire(ptyId, incarnationId)
  }
  protected abstract isContextProtectedPane(rawPaneKey: unknown): boolean

  protected requiresContextAdmission(source: AgentHookSource, body: unknown): boolean {
    return (
      source === 'claude' ||
      source === 'codex' ||
      (typeof body === 'object' &&
        body !== null &&
        'paneKey' in body &&
        this.isContextProtectedPane(body.paneKey))
    )
  }

  protected checkRequestedProvider(
    snapshot: HookContextSnapshot,
    agent: unknown,
    providerSessionId: string | undefined,
    eventName: unknown,
    eventSource: unknown,
    replay = false
  ): boolean {
    const reason = this.requestedProviderIntents.check(
      snapshot,
      agent,
      providerSessionId,
      eventName,
      eventSource,
      replay
    )
    return reason
      ? this.refuseUnverifiedContext(reason, {
          paneKey: snapshot.paneKey,
          worktreeId: snapshot.worktreeId,
          providerSessionId
        })
      : true
  }

  protected checkNormalizedRequestedProvider(
    context: AdmittedHookContext,
    event: NonNullable<NormalizedLocalHook['event']>,
    replay: boolean
  ): boolean {
    return this.checkRequestedProvider(
      context.snapshot,
      event.payload.agentType,
      event.providerSession?.id,
      context.envelope.eventName,
      context.envelope.hookPayloadRecord.source,
      replay
    )
  }

  protected noteRequestedProviderCommit(
    source: AgentHookSource,
    context: true | AdmittedHookContext | undefined,
    event: EnrichedAgentHookEventPayload
  ): void {
    if (!context || context === true || event.isReplay) {
      return
    }
    this.requestedProviderIntents.commit(
      context.snapshot,
      source,
      event.providerSession?.id,
      context.envelope.eventName,
      context.envelope.hookPayloadRecord.source
    )
  }
}
