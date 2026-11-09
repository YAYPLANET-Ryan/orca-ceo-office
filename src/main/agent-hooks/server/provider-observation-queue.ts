import {
  readHookProviderObservation,
  type HookProviderObservation,
  type HookProviderObservationUpdate
} from '../../../shared/agent-hook-listener/state/hook-provider-observation'
import { matchesProviderObservationScope } from './provider-observation-scope'

export type ProviderObservationWriter = (
  update: HookProviderObservationUpdate
) => Promise<HookProviderObservation | null>

type PendingScope = {
  ptyId: string
  incarnationId: string
  jobs: HookProviderObservationUpdate[]
  revision: number
  retired?: boolean
  blocked?: boolean
  running?: Promise<void>
}

/** Memory-only pending capabilities, never an authority or a durable resume receipt. */
export class ProviderObservationQueue {
  private readonly scopes = new Map<string, PendingScope>()
  private writer: ProviderObservationWriter | undefined
  // A dropped transition stays unqualified even after ordinary jobs drain.
  private overflowed = false
  private pendingCount = 0
  private pendingRetirementRevision = 0

  constructor(private readonly unavailable: () => void) {}

  get hasPending(): boolean {
    return this.pendingCount > 0 || this.overflowed
  }

  setWriter(writer: ProviderObservationWriter): void {
    this.writer = writer
  }

  retire(ptyId: string, incarnationId: string | undefined): void {
    if (!incarnationId) {
      return
    }
    for (const [key, scope] of this.scopes) {
      if (scope.ptyId === ptyId && scope.incarnationId === incarnationId) {
        scope.retired = true
        if (scope.jobs.length > 0) {
          this.pendingRetirementRevision++
        }
        this.pendingCount -= scope.jobs.length
        scope.jobs = []
        this.scopes.delete(key)
      }
    }
  }

  enqueue(update: HookProviderObservationUpdate): void {
    if (!this.writer) {
      return
    }
    const key = JSON.stringify([
      update.ptyId,
      update.incarnationId,
      update.paneKey,
      update.worktreeId,
      update.ownerClientInstanceId,
      update.launchTokenHash,
      update.launchCwd,
      update.cwd
    ])
    let scope = this.scopes.get(key)
    if (scope?.blocked) {
      return
    }
    const tail = scope?.jobs.at(-1)
    if (
      tail?.providerSessionId === update.providerSessionId &&
      tail.agentType === update.agentType
    ) {
      this.start(scope!)
      return
    }
    if (
      (!scope && this.scopes.size >= 4096) ||
      this.pendingCount >= 4096 ||
      (scope && scope.jobs.length >= 64)
    ) {
      this.overflowed = true
      this.unavailable()
      return
    }
    if (!scope) {
      scope = {
        jobs: [],
        revision: update.expectedRevision,
        ptyId: update.ptyId,
        incarnationId: update.incarnationId
      }
      this.scopes.set(key, scope)
    }
    scope.jobs.push(update)
    this.pendingCount++
    this.start(scope)
  }

  async flush(): Promise<boolean> {
    if (!this.writer) {
      return false
    }
    const retirementRevision = this.pendingRetirementRevision
    // One attempt per pending scope: failed writes remain queued, without a retry loop.
    const attempts = [...this.scopes.values()]
      .filter((scope) => scope.jobs.length > 0)
      .map((scope) => this.start(scope))
    await Promise.all(attempts)
    return (
      !this.overflowed &&
      this.pendingCount === 0 &&
      retirementRevision === this.pendingRetirementRevision
    )
  }

  private start(scope: PendingScope): Promise<void> {
    if (scope.blocked) {
      return Promise.resolve()
    }
    if (scope.running) {
      return scope.running
    }
    const running = this.drain(scope).finally(() => {
      scope.running = undefined
      // Retain the acknowledged revision until exact physical exit. A hook may
      // have read its immutable scope before this acknowledgement arrived.
    })
    scope.running = running
    return running
  }

  private async drain(scope: PendingScope): Promise<void> {
    while (scope.jobs.length > 0) {
      const job = scope.jobs[0]
      try {
        const receipt = readHookProviderObservation(
          await this.writer!({
            ...job,
            expectedRevision: scope.revision
          })
        )
        if (scope.retired) {
          return
        }
        if (
          !receipt ||
          !matchesProviderObservationScope(receipt, job) ||
          receipt.agentType !== job.agentType ||
          receipt.providerSessionId !== job.providerSessionId ||
          receipt.revision < scope.revision ||
          receipt.revision > scope.revision + 1
        ) {
          throw new Error('hook_provider_observation_ack_unconfirmed')
        }
        scope.revision = receipt.revision
        scope.jobs.shift()
        this.pendingCount--
      } catch (error) {
        if (!scope.retired) {
          // These requests contradict this frozen generation. Preserve the head
          // for diagnostics, but do not spin or queue further transitions behind it.
          scope.blocked =
            error instanceof Error &&
            [
              'hook_provider_observation_original_unconfirmed',
              'hook_provider_observation_transition_unconfirmed',
              'hook_provider_observation_current_revision_changed',
              'hook_provider_observation_revision_changed'
            ].some((reason) => error.message.endsWith(reason))
          this.unavailable()
        }
        return
      }
    }
  }
}
