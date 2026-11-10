import { launchTokenHash } from '../../../shared/agent-hook-listener/transport/agent-hook-spool'
import { isClaudeOrCodexContext } from './context-protected-pane'
import { PrioritySemaphore } from '../../../shared/priority-semaphore'
import type {
  HookRootEvidenceReader,
  HookTransportPeer
} from '../../../shared/agent-hook-listener/presence/hook-process-root-evidence'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { parseHookEnvelope } from '../../../shared/agent-hook-listener/hook-envelope'
import { readHookAgentProcess } from '../../../shared/agent-status/process/agent-process-presence'
import { extractAgentProviderSession } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  sameHookContextSnapshot,
  type HookContextSnapshotReader,
  type AdmittedHookContext
} from './hook-context-snapshot'
import { AgentHookServerRequestedProviderContext } from './server-requested-provider-context'
import type { RemoteAgentStatusEnvelope } from './server-remote-envelope-normalization'
import type { NormalizedLocalHook } from './server-types'

export abstract class AgentHookServerContextAdmission extends AgentHookServerRequestedProviderContext {
  beginRemoteRelaySession(connectionId: string): void {
    this.relaySessions.begin(connectionId)
  }

  /** Unset in tests and embedders without a process table: every acquisition reads as unknown. */
  protected readHookRootEvidence: HookRootEvidenceReader | undefined
  private readHookContextSnapshot: HookContextSnapshotReader | undefined
  private readContextVerificationCapability: () => boolean = () => true
  private contextAdmissionSlot = new PrioritySemaphore(1)
  private contextAdmissionController = new AbortController()
  protected undecidedOwnerChallenges = new Map<string, number>()

  protected resetContextAdmission(): void {
    this.contextAdmissionController.abort()
    this.contextAdmissionController = new AbortController()
    this.contextAdmissionSlot = new PrioritySemaphore(1)
    this.undecidedOwnerChallenges = new Map()
    this.resetContextIntegrityRejections()
    // A listener restart does not end the physical PTY generation. Keep committed
    // bindings until its exact exit; otherwise a lagging host ack can restore an old ID.
  }

  setHookContextSnapshotReader(reader: HookContextSnapshotReader): void {
    this.readHookContextSnapshot = reader
  }

  setContextVerificationCapabilityReader(reader: () => boolean): void {
    this.readContextVerificationCapability = reader
  }

  protected hasContextVerificationReaders(): boolean {
    try {
      return Boolean(
        this.readHookContextSnapshot &&
        this.readHookRootEvidence &&
        this.readContextVerificationCapability()
      )
    } catch {
      return false
    }
  }

  protected isContextProtectedPane(rawPaneKey: unknown): boolean {
    if (typeof rawPaneKey !== 'string') {
      return false
    }
    const paneKey = this.resolvePaneKeyAlias(rawPaneKey.trim())
    return isClaudeOrCodexContext(
      this.getStatusSnapshotForPane(paneKey).map((row) => row.agentType),
      () => this.getProviderSessionIdentities().some((row) => row.paneKey === paneKey)
    )
  }

  protected async admitLocalHookContext(
    source: AgentHookSource,
    body: unknown,
    peer?: HookTransportPeer,
    replay = false
  ): Promise<boolean | AdmittedHookContext> {
    const read = this.readHookContextSnapshot
    if (source !== 'claude' && source !== 'codex') {
      return this.requiresContextAdmission(source, body)
        ? this.refuseUnverifiedContext('unattested_source_targets_protected_pane')
        : true
    }
    if (!read) {
      return this.refuseUnverifiedContext('context_reader_unavailable')
    }
    const parsed = parseHookEnvelope(this.state, source, body, this.env)
    if (!parsed) {
      return this.refuseUnverifiedContext('invalid_context_claim')
    }
    const envelope = Object.freeze({
      ...parsed,
      record: Object.freeze({ ...parsed.record }),
      hookPayloadRecord: Object.freeze({ ...parsed.hookPayloadRecord })
    })
    const record = envelope.record
    const refuse = (reason: string) =>
      this.refuseUnverifiedContext(reason, {
        paneKey: envelope.paneKey,
        worktreeId: envelope.worktreeId,
        providerSessionId: extractAgentProviderSession(source, envelope.hookPayloadRecord)?.id
      })
    if (
      (record.connectionId != null && record.connectionId !== '') ||
      (record.executionHostId !== undefined && record.executionHostId !== 'local')
    ) {
      return refuse('foreign_execution_host')
    }
    let release: (() => void) | undefined
    let committed = false
    let queued = true
    const ownerExit = this.agentExitedAtByPaneKey.get(envelope.paneKey)
    const lifecycle = this.contextAdmissionController
    const signal = AbortSignal.any([AbortSignal.timeout(500), lifecycle.signal])
    const withinDeadline = <T>(operation: () => Promise<T>): Promise<T> =>
      new Promise((resolve, reject) => {
        const abort = () => reject(signal.reason)
        if (signal.aborted) {
          abort()
          return
        }
        signal.addEventListener('abort', abort, { once: true })
        Promise.resolve()
          .then(operation)
          .then(resolve, reject)
          .finally(() => {
            signal.removeEventListener('abort', abort)
          })
      })
    try {
      const releaseSlot = await this.contextAdmissionSlot.acquire(0, signal)
      queued = false
      const paneKey = envelope.paneKey
      const challenges = this.undecidedOwnerChallenges
      challenges.set(paneKey, (challenges.get(paneKey) ?? 0) + 1)
      let released = false
      release = () => {
        if (released) {
          return
        }
        released = true
        const remaining = (challenges.get(paneKey) ?? 1) - 1
        if (remaining > 0) {
          challenges.set(paneKey, remaining)
        } else {
          challenges.delete(paneKey)
        }
        releaseSlot()
      }
      const observed = await withinDeadline(() => read(envelope))
      const snapshot = observed && { ...observed }
      if (
        !snapshot ||
        snapshot.executionHostId !== 'local' ||
        snapshot.paneKey !== envelope.paneKey ||
        snapshot.worktreeId !== envelope.worktreeId ||
        !snapshot.ptyId ||
        !snapshot.incarnationId ||
        !snapshot.cwd ||
        snapshot.cwd !== snapshot.reportedCwd
      ) {
        return refuse('workspace_cwd_unconfirmed')
      }
      const process = readHookAgentProcess(source, record.agentProcess)
      const launchToken = envelope.launchToken
      if (
        !launchToken ||
        launchToken.length > 128 ||
        launchTokenHash(launchToken) !== snapshot.launchTokenHash
      ) {
        return refuse('launch_generation_unconfirmed')
      }
      const proof =
        (process || peer) &&
        (await withinDeadline(async () =>
          this.readHookRootEvidence?.({
            paneKey: envelope.paneKey,
            worktreeId: envelope.worktreeId,
            agent: source,
            process: process ?? {
              pid: peer!.pid,
              platform: 'win32',
              startTime: peer!.creationTimeKey
            },
            ...(peer ? { peer } : {}),
            signal
          })
        ))
      // A transport helper is not the provider; only the host reader can replace a missing claim.
      if (
        proof?.verdict !== 'root' ||
        proof.binding !== snapshot.incarnationId ||
        (!process && !proof.process)
      ) {
        return refuse('process_generation_unconfirmed')
      }
      const provider = extractAgentProviderSession(source, envelope.hookPayloadRecord)
      const current = await withinDeadline(() => read(envelope))
      if (signal.aborted || !current || !sameHookContextSnapshot(snapshot, current)) {
        return refuse('context_changed_during_verification')
      }
      // Observation acknowledgements may advance while immutable PTY ownership stays unchanged.
      snapshot.providerObservation = current.providerObservation
      if (peer && !peer.isCurrent()) {
        return refuse('hook_transport_caller_changed')
      }
      if (this.agentExitedAtByPaneKey.get(envelope.paneKey) !== ownerExit) {
        return refuse('agent_exited_during_context_verification')
      }
      if (
        !this.checkRequestedProvider(
          snapshot,
          source,
          provider?.id,
          envelope.eventName,
          envelope.hookPayloadRecord.source,
          replay
        )
      ) {
        return false
      }
      if (
        provider &&
        this.getProviderSessionIdentities().some(
          (row) =>
            row.sessionId === provider.id &&
            (row.paneKey !== envelope.paneKey || row.worktreeId !== envelope.worktreeId)
        )
      ) {
        return refuse('provider_owned_by_another_pane')
      }
      committed = true
      return {
        envelope: proof.process
          ? Object.freeze({
              ...envelope,
              record: Object.freeze({
                ...envelope.record,
                agentProcess: Object.freeze({ ...proof.process })
              })
            })
          : envelope,
        snapshot: Object.freeze(snapshot),
        processRootVerified: true,
        ownerExit,
        ...(peer ? { peer } : {}),
        release
      }
    } catch {
      if (lifecycle !== this.contextAdmissionController) {
        return false
      }
      return refuse(queued ? 'context_admission_queue_unavailable' : 'context_evidence_unavailable')
    } finally {
      if (!committed) {
        release?.()
      }
    }
  }

  protected canCommitHookContext(
    context: AdmittedHookContext,
    event: NormalizedLocalHook['event'],
    replay = false
  ): boolean {
    if (
      !event ||
      (context.peer && !context.peer.isCurrent()) ||
      event.paneKey !== context.snapshot.paneKey ||
      event.worktreeId !== context.snapshot.worktreeId ||
      this.agentExitedAtByPaneKey.get(event.paneKey) !== context.ownerExit
    ) {
      return this.refuseUnverifiedContext('context_changed_before_commit')
    }
    const ids = [event.providerSession?.id, event.statusAdmissionSession].filter(Boolean)
    if (!this.checkNormalizedRequestedProvider(context, event, replay)) {
      return false
    }
    if (
      this.getProviderSessionIdentities().some(
        (row) =>
          ids.includes(row.sessionId) &&
          (row.paneKey !== event.paneKey || row.worktreeId !== event.worktreeId)
      )
    ) {
      return this.refuseUnverifiedContext('normalized_provider_owned_by_another_pane')
    }
    return true
  }

  setHookRootEvidenceReader(reader: HookRootEvidenceReader): void {
    this.readHookRootEvidence = reader
  }

  protected admitRemoteContext(envelope: RemoteAgentStatusEnvelope): boolean {
    const payloadAgent =
      envelope?.payload && typeof envelope.payload === 'object' && 'agentType' in envelope.payload
        ? envelope.payload.agentType
        : undefined
    if (
      envelope?.source === 'claude' ||
      envelope?.source === 'codex' ||
      payloadAgent === 'claude' ||
      payloadAgent === 'codex' ||
      envelope?.providerSession !== undefined ||
      this.isContextProtectedPane(envelope?.paneKey)
    ) {
      return this.refuseUnverifiedContext('remote_context_attestation_unavailable')
    }
    return true
  }
}
