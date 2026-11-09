import { AgentHookServerContextDiagnostics } from './server-context-diagnostics'
import { RequestedProviderIntentFence } from './requested-provider-intent-fence'
import type { HookContextSnapshot, AdmittedHookContext } from './hook-context-snapshot'
import type { EnrichedAgentHookEventPayload, NormalizedLocalHook } from './server-types'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import {
  ProviderObservationQueue,
  type ProviderObservationWriter
} from './provider-observation-queue'
import { providerObservationScope } from './provider-observation-scope'
import { readHookProviderObservationUpdate } from '../../../shared/agent-hook-listener/state/hook-provider-observation'

export abstract class AgentHookServerRequestedProviderContext extends AgentHookServerContextDiagnostics {
  protected readonly requestedProviderIntents = new RequestedProviderIntentFence()
  private readonly providerObservations = new ProviderObservationQueue(() => {
    this.refuseUnverifiedContext('provider_observation_ack_unavailable')
  })

  setProviderObservationWriter(writer: ProviderObservationWriter): void {
    this.providerObservations.setWriter(writer)
  }

  flushProviderObservations(): Promise<boolean> {
    return this.providerObservations.flush()
  }
  retireRequestedProviderIntent(ptyId: string, incarnationId: string | undefined): void {
    this.requestedProviderIntents.retire(ptyId, incarnationId)
    this.providerObservations.retire(ptyId, incarnationId)
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
    const scope = providerObservationScope(context.snapshot)
    const update =
      scope &&
      readHookProviderObservationUpdate({
        ...scope,
        expectedRevision: context.snapshot.providerObservation?.revision ?? 0,
        agentType: source,
        providerSessionId: event.providerSession?.id,
        transition:
          context.envelope.eventName === 'SessionStart' &&
          context.envelope.hookPayloadRecord.source === 'clear'
            ? 'clear'
            : 'observed',
        launchToken: context.envelope.launchToken
      })
    if (update) {
      this.providerObservations.enqueue(update)
    } else if (scope) {
      this.refuseUnverifiedContext('provider_observation_ack_unavailable')
    }
  }
}
