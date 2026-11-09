import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { AtomicSnapshotWriter } from '../persistence/atomic-snapshot-writer'
import { normalizeHookContextReason } from '../../shared/agent-hook-listener/state/hook-context-quarantine-types'
import type {
  HookContextQuarantineEntry,
  HookContextQuarantineSnapshot
} from '../../shared/agent-hook-listener/state/hook-context-quarantine-types'

const MAX_ENTRIES = 256
const MAX_FILE_BYTES = 128 * 1024
const MAX_COUNT = Number.MAX_SAFE_INTEGER
const validReason = (value: unknown): value is string =>
  typeof value === 'string' && normalizeHookContextReason(value) === value
const validCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** Accept only selected technical identifiers, and retain their digest rather than raw text. */
export function hookContextClaimFingerprint(claim: {
  paneKey?: string
  worktreeId?: string
  providerSessionId?: string
}): string | undefined {
  const fields = [claim.paneKey, claim.worktreeId, claim.providerSessionId]
  if (!fields.some((value) => typeof value === 'string' && value.length > 0)) {
    return undefined
  }
  return createHash('sha256')
    .update(JSON.stringify(fields.map((value) => value?.slice(0, 2048) ?? null)))
    .digest('hex')
}

function readEntries(raw: unknown): {
  entries: HookContextQuarantineEntry[]
  overflowCount: number
} {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('version' in raw) ||
    raw.version !== 1 ||
    !('entries' in raw) ||
    !Array.isArray(raw.entries) ||
    raw.entries.length > MAX_ENTRIES ||
    !('overflowCount' in raw) ||
    !validCount(raw.overflowCount) ||
    Object.keys(raw).some((key) => !['version', 'entries', 'overflowCount'].includes(key))
  ) {
    throw new Error('Invalid quarantine summary')
  }
  const entries = raw.entries.map((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('reason' in entry) ||
      !validReason(entry.reason) ||
      !('firstSeenAt' in entry) ||
      !validCount(entry.firstSeenAt) ||
      !('lastSeenAt' in entry) ||
      !validCount(entry.lastSeenAt) ||
      entry.lastSeenAt < entry.firstSeenAt ||
      !('count' in entry) ||
      !validCount(entry.count) ||
      entry.count === 0 ||
      Object.keys(entry).some(
        (key) => !['reason', 'fingerprint', 'firstSeenAt', 'lastSeenAt', 'count'].includes(key)
      )
    ) {
      throw new Error('Invalid quarantine entry')
    }
    const fingerprint = 'fingerprint' in entry ? entry.fingerprint : undefined
    if (
      fingerprint !== undefined &&
      (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint))
    ) {
      throw new Error('Invalid quarantine fingerprint')
    }
    return {
      reason: entry.reason,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      count: entry.count,
      ...(fingerprint ? { fingerprint } : {})
    }
  })
  const keys = entries.map((entry) => `${entry.reason}:${entry.fingerprint ?? ''}`)
  if (new Set(keys).size !== keys.length) {
    throw new Error('Duplicate quarantine entries')
  }
  return { entries, overflowCount: raw.overflowCount }
}

/** Bounded metadata-only refusal summary. It cannot supply identities to status or resume. */
export class HookContextQuarantine {
  private readonly entries = new Map<string, HookContextQuarantineEntry>()
  private overflowCount = 0
  private writer: AtomicSnapshotWriter | undefined
  private durability: HookContextQuarantineSnapshot['durability'] = 'memory-only'
  private readonly listeners = new Set<(snapshot: HookContextQuarantineSnapshot) => void>()
  private retry: ReturnType<typeof setTimeout> | undefined
  private revision = 0
  private closed = false
  private opened = false
  private retryDelayMs = 1000
  private readonly warnedSubscribers = new WeakSet<
    (snapshot: HookContextQuarantineSnapshot) => void
  >()

  open(file: string): void {
    this.close()
    this.closed = false
    this.opened = true
    this.entries.clear()
    this.overflowCount = 0
    this.retryDelayMs = 1000
    this.durability = 'pending'
    try {
      if (statSync(file).size > MAX_FILE_BYTES) {
        throw new Error('Quarantine summary too large')
      }
      const saved = readEntries(JSON.parse(readFileSync(file, 'utf8')))
      for (const entry of saved.entries) {
        this.entries.set(this.key(entry), entry)
      }
      this.overflowCount = saved.overflowCount
      this.durability = 'saved'
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        // Preserve malformed/oversized bytes for review; never overwrite them with defaults.
        this.durability = 'unavailable'
        this.emit()
        return
      }
    }
    this.writer = new AtomicSnapshotWriter(() => file, {
      fileMode: 0o600,
      directoryMode: 0o700,
      skipUnchanged: true
    })
    // No refusal data is outstanding when a fresh profile has no file yet.
    if (this.entries.size === 0 && this.overflowCount === 0) {
      this.durability = 'saved'
    }
    this.emit()
  }

  record(reason: string, fingerprint?: string): void {
    if (
      !validReason(reason) ||
      (fingerprint !== undefined && !/^[a-f0-9]{64}$/.test(fingerprint))
    ) {
      reason = 'invalid_context_reason'
      fingerprint = undefined
    }
    const now = Date.now()
    const key = this.key({ reason, fingerprint })
    const previous = this.entries.get(key)
    if (previous) {
      previous.count = Math.min(MAX_COUNT, previous.count + 1)
      previous.lastSeenAt = Math.max(previous.lastSeenAt, now)
    } else if (this.entries.size < MAX_ENTRIES) {
      this.entries.set(key, {
        reason,
        ...(fingerprint ? { fingerprint } : {}),
        firstSeenAt: now,
        lastSeenAt: now,
        count: 1
      })
    } else {
      // Keep original entries and make capacity loss visible instead of silently evicting them.
      this.overflowCount = Math.min(MAX_COUNT, this.overflowCount + 1)
    }
    this.revision++
    if (this.closed) {
      this.durability = 'memory-only'
    } else if (this.writer && !this.retry) {
      this.durability = 'pending'
    }
    this.emit()
    this.persist()
  }

  snapshot(): HookContextQuarantineSnapshot {
    return {
      version: 1,
      entries: [...this.entries.values()].map((entry) => ({ ...entry })),
      overflowCount: this.overflowCount,
      durability: this.durability
    }
  }

  isOpen(): boolean {
    return this.opened && !this.closed
  }

  subscribe(listener: (snapshot: HookContextQuarantineSnapshot) => void): () => void {
    this.listeners.add(listener)
    this.emitOne(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  close(): void {
    this.closed = true
    clearTimeout(this.retry)
    this.retry = undefined
    if (this.writer) {
      try {
        this.writer.writeSync(() => this.serialize())
        this.durability = 'saved'
      } catch {
        this.durability = 'unavailable'
      }
      this.writer.close()
      this.writer = undefined
    }
    this.emit()
  }

  private key(entry: { reason: string; fingerprint?: string }): string {
    return `${entry.reason}:${entry.fingerprint ?? ''}`
  }

  private serialize(): string {
    return JSON.stringify({
      version: 1,
      entries: [...this.entries.values()],
      overflowCount: this.overflowCount
    })
  }

  private persist(): void {
    const writer = this.writer
    const revision = this.revision
    if (!writer || this.closed || this.retry) {
      return
    }
    void writer
      .write(() => this.serialize())
      .then(
        () => {
          if (this.writer !== writer || this.closed || this.revision !== revision) {
            return
          }
          this.durability = 'saved'
          this.retryDelayMs = 1000
          this.emit()
        },
        () => {
          if (this.writer !== writer || this.closed) {
            return
          }
          const changed = this.durability !== 'unavailable'
          this.durability = 'unavailable'
          if (changed) {
            this.emit()
          }
          if (!this.retry) {
            this.retry = setTimeout(() => {
              this.retry = undefined
              this.persist()
            }, this.retryDelayMs)
            this.retryDelayMs = Math.min(60_000, this.retryDelayMs * 2)
            this.retry.unref()
          }
        }
      )
  }

  private emitOne(listener: (snapshot: HookContextQuarantineSnapshot) => void): void {
    try {
      listener(this.snapshot())
    } catch {
      if (!this.warnedSubscribers.has(listener)) {
        this.warnedSubscribers.add(listener)
        console.warn('[agent-hooks] Context quarantine subscriber failed')
      }
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      this.emitOne(listener)
    }
  }
}
