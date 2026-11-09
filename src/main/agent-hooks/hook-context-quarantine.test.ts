import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { AtomicSnapshotWriter } from '../persistence/atomic-snapshot-writer'
import { HookContextQuarantine, hookContextClaimFingerprint } from './hook-context-quarantine'

const roots: string[] = []
const stores: HookContextQuarantine[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orca-context-quarantine-'))
  roots.push(root)
  const file = join(root, 'quarantine.json')
  const store = new HookContextQuarantine()
  stores.push(store)
  return { root, file, store }
}
afterEach(() => {
  for (const store of stores.splice(0)) {
    store.close()
  }
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith('orca-context-quarantine-')
    ) {
      throw new Error('Refusing cleanup outside own quarantine fixture')
    }
    rmSync(root, { recursive: true, force: true })
  }
})

describe('unattributed context quarantine', () => {
  it('persists refusal metadata across restart without raw identities or body fields', async () => {
    const { store, file } = fixture()
    const fingerprint = hookContextClaimFingerprint({
      paneKey: 'synthetic-pane',
      worktreeId: 'synthetic-workspace',
      providerSessionId: 'synthetic-provider'
    })
    store.open(file)
    store.record('workspace_cwd_unconfirmed', fingerprint)
    store.record('workspace_cwd_unconfirmed', fingerprint)
    await vi.waitFor(() => expect(store.snapshot().durability).toBe('saved'))
    store.close()
    const bytes = readFileSync(file, 'utf8')
    expect(bytes).not.toContain('synthetic-pane')
    expect(bytes).not.toContain('synthetic-workspace')
    expect(bytes).not.toContain('synthetic-provider')
    expect(bytes).not.toContain('payload')
    const restarted = new HookContextQuarantine()
    stores.push(restarted)
    restarted.open(file)
    expect(restarted.snapshot()).toMatchObject({
      durability: 'saved',
      entries: [
        {
          reason: 'workspace_cwd_unconfirmed',
          fingerprint: 'ed5e60e40e43b830dc47adcdbb883676a7334a0becd49620378cfd250056651a',
          count: 2
        }
      ]
    })
  })

  it.each([
    '{broken',
    JSON.stringify({ version: 1, entries: [], overflowCount: 0, unknown: 'preserve-me' })
  ])(
    'preserves corrupt or unexpected saved bytes rather than overwriting with defaults',
    (bytes) => {
      const { store, file } = fixture()
      writeFileSync(file, bytes)
      store.open(file)
      store.record('context_reader_unavailable')
      expect(store.snapshot().durability).toBe('unavailable')
      store.close()
      expect(readFileSync(file, 'utf8')).toBe(bytes)
    }
  )

  it('reports a failed durable write and retains the in-memory refusal for retry', async () => {
    const { store, file } = fixture()
    store.open(file)
    vi.spyOn(AtomicSnapshotWriter.prototype, 'write').mockRejectedValue(
      new Error('synthetic disk failure')
    )
    store.record('process_generation_unconfirmed')
    await vi.waitFor(() => expect(store.snapshot().durability).toBe('unavailable'))
    expect(store.snapshot().entries[0]?.count).toBe(1)
  })

  it('isolates failing subscribers and never lets snapshots mutate stored entries', () => {
    const { store } = fixture()
    const received = vi.fn()
    store.subscribe(() => {
      throw new Error('synthetic subscriber failure')
    })
    store.subscribe(received)
    store.record('provider_owned_by_another_pane')
    store.snapshot().entries[0]!.count = 999
    expect(store.snapshot().entries[0]?.count).toBe(1)
    expect(received).toHaveBeenLastCalledWith(
      expect.objectContaining({ entries: [expect.objectContaining({ count: 1 })] })
    )
  })

  it('does not report late records after close as saved', () => {
    const { store, file } = fixture()
    store.open(file)
    store.record('context_reader_unavailable')
    store.close()
    store.record('context_reader_unavailable')
    expect(store.snapshot()).toMatchObject({ durability: 'memory-only', entries: [{ count: 2 }] })
    expect(JSON.parse(readFileSync(file, 'utf8')).entries[0].count).toBe(1)
  })

  it('keeps refusal diagnostics non-throwing when an internal reason is malformed', () => {
    const { store } = fixture()
    expect(() => store.record('malformed-reason-123')).not.toThrow()
    expect(store.snapshot().entries[0]?.reason).toBe('invalid_context_reason')
  })

  it('keeps existing entries and makes bounded-capacity loss visible', () => {
    const { store } = fixture()
    for (let index = 0; index < 260; index++) {
      store.record(
        'workspace_cwd_unconfirmed',
        hookContextClaimFingerprint({ paneKey: `synthetic-${index}` })
      )
    }
    expect(store.snapshot().entries).toHaveLength(256)
    expect(store.snapshot().overflowCount).toBe(4)
    expect(store.snapshot().entries[0]?.fingerprint).toBe(
      'dcccf351e7d698f0cf62c5b7329169458952e5f144af31df32d8c9f5aa8cdb53'
    )
  })
})
