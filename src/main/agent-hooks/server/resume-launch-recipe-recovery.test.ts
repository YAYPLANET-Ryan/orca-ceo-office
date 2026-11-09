import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import Database from '../../sqlite/sync-database'
import { ResumeLaunchRecipeJournal } from './resume-launch-recipe-journal'
import { markRecipeJournalReady, prepareRecipeJournalOwner } from './resume-recipe-journal-owner'
import * as secureFile from '../../../shared/secure-storage/secure-file'

const PROFILE = 'a'.repeat(64)
const event = {
  paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
  worktreeId: 'workspace-a',
  agentType: 'codex',
  providerSession: { key: 'session_id' as const, id: 'original-conversation' },
  launchedAt: 100
}
let root: string
let file: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-resume-recipe-recovery-'))
  file = join(root, 'resume-recipes-v1.sqlite')
})

afterEach(() => {
  vi.restoreAllMocks()
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith('orca-resume-recipe-recovery-')
  ) {
    throw new Error('Refusing cleanup outside own recovery fixture')
  }
  rmSync(root, { recursive: true, force: true })
})

it('retries failed initial COMMIT without discarding the original in-memory request', () => {
  const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
  journal.record(event)
  const original = Database.prototype.exec
  let fail = true
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database, sql: string) {
    if (sql === 'COMMIT' && fail) {
      fail = false
      throw new Error('Synthetic initial commit failure')
    }
    return original.call(this, sql)
  })
  expect(journal.flush()).toBe(false)
  expect(journal.snapshot().pending).toBe(true)
  expect(journal.flush()).toBe(true)
  expect(new ResumeLaunchRecipeJournal(file, PROFILE).snapshot().recipes).toMatchObject([
    { verification: 'unverified', providerSession: { id: 'original-conversation' } }
  ])
})

it('recognizes a durable owned initialization marker on the next instance', () => {
  prepareRecipeJournalOwner(file, PROFILE, true)
  writeFileSync(file, '')
  const next = new ResumeLaunchRecipeJournal(file, PROFILE)
  next.record(event)
  expect(next.flush()).toBe(true)
  expect(next.snapshot().recipes[0]?.providerSession.id).toBe('original-conversation')
})

it('preserves an unrecognized zero-byte file instead of claiming a new journal', () => {
  writeFileSync(file, '')
  const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
  journal.record(event)
  expect(journal.flush()).toBe(false)
  expect(readFileSync(file)).toHaveLength(0)
  expect(() => readFileSync(`${file}.owner-v1.json`)).toThrow()
})

it.each(['malformed', 'foreign'] as const)(
  'preserves a %s ownership marker and its database',
  (kind) => {
    const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
    journal.record(event)
    expect(journal.flush()).toBe(true)
    const marker =
      kind === 'malformed'
        ? 'incomplete-marker'
        : JSON.stringify({
            version: 1,
            kind: 'orca-unverified-resume-recipes',
            profileId: 'b'.repeat(64)
          })
    writeFileSync(`${file}.owner-v1.json`, marker)
    const before = readFileSync(file)
    journal.record({ ...event, launchedAt: 101 })
    expect(journal.flush()).toBe(false)
    expect(readFileSync(file)).toEqual(before)
    expect(readFileSync(`${file}.owner-v1.json`, 'utf8')).toBe(marker)
    expect(journal.snapshot()).toMatchObject({ unavailable: true, pending: true })
  }
)

async function interruptSqliteFixture(statements: string[]): Promise<void> {
  const script = join(root, 'sqlite-crash-fixture.cjs')
  writeFileSync(
    script,
    [
      "const { DatabaseSync } = require('node:sqlite')",
      'const db = new DatabaseSync(process.argv[2])',
      "db.exec('PRAGMA cache_size=1; PRAGMA cache_spill=ON; BEGIN IMMEDIATE')",
      ...statements,
      "process.send('fixture-ready')",
      'setInterval(() => {}, 1000)'
    ].join('\n')
  )
  const child = fork(script, [file], {
    execPath: process.execPath,
    execArgv: [],
    env: {},
    stdio: ['ignore', 'ignore', 'ignore', 'ipc']
  })
  try {
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(5000) })
    expect(ready).toBe('fixture-ready')
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) })
    child.kill('SIGKILL')
    await exited
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) })
      child.kill('SIGKILL')
      await exited
    }
  }
}

it('recovers a real rollback journal after only its isolated fixture writer is interrupted', async () => {
  const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
  journal.record(event)
  expect(journal.flush()).toBe(true)
  await interruptSqliteFixture([
    "db.prepare('UPDATE resume_recipes SET metadata_json=?').run('x'.repeat(4 * 1024 * 1024))"
  ])
  expect(readFileSync(`${file}-journal`).length).toBeGreaterThan(0)
  expect(journal.snapshot().unavailable).toBe(true)
  expect(journal.flush()).toBe(true)
  expect(journal.snapshot().recipes).toMatchObject([
    { providerSession: { id: 'original-conversation' } }
  ])
  journal.record({ ...event, launchedAt: 101 })
  expect(journal.flush()).toBe(true)
  expect(journal.snapshot()).toMatchObject({ unavailable: false, pending: false })
  expect(journal.snapshot().recipes.map(({ providerSession }) => providerSession.id)).toEqual([
    'original-conversation',
    'original-conversation'
  ])
}, 15000)

it('initializes on the first retry when rollback restores a pre-schema owned database', async () => {
  prepareRecipeJournalOwner(file, PROFILE, true)
  writeFileSync(file, '')
  await interruptSqliteFixture([
    "db.exec('PRAGMA application_id=1330795082; PRAGMA user_version=1; CREATE TABLE pending_init(payload TEXT)')",
    "db.prepare('INSERT INTO pending_init VALUES(?)').run('x'.repeat(4 * 1024 * 1024))"
  ])
  const diagnostic: Record<string, unknown> = {
    header: readFileSync(file).subarray(0, 100).toString('hex')
  }
  let probe: Database | undefined
  try {
    probe = new Database(file, { readonly: true, fileMustExist: true })
    diagnostic.version = probe.pragma('user_version', { simple: true })
    diagnostic.application = probe.pragma('application_id', { simple: true })
    diagnostic.tables = probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'errcode' in error &&
      typeof error.errcode === 'number'
    ) {
      diagnostic.errcode = error.errcode
    }
  } finally {
    probe?.close()
  }
  const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
  journal.record(event)
  expect(journal.flush(), JSON.stringify(diagnostic)).toBe(true)
  expect(journal.snapshot().recipes[0]?.providerSession.id).toBe('original-conversation')
}, 15000)

it.each(['-journal', '-wal', '-shm'])(
  'preserves an orphaned %s without creating an owner or database',
  (suffix) => {
    const sidecar = `${file}${suffix}`
    writeFileSync(sidecar, 'orphaned-fixture-sidecar')
    const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
    journal.record(event)
    expect(journal.flush()).toBe(false)
    expect(journal.snapshot().unavailable).toBe(true)
    expect(readFileSync(sidecar, 'utf8')).toBe('orphaned-fixture-sidecar')
    expect(() => readFileSync(file)).toThrow()
    expect(() => readFileSync(`${file}.owner-v1.json`)).toThrow()
  }
)

it('refuses a dangling database link rather than following it on creation', () => {
  const target = join(root, 'missing-target')
  symlinkSync(target, file, 'junction')
  const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
  journal.record(event)
  expect(journal.flush()).toBe(false)
  expect(() => readFileSync(target)).toThrow()
  expect(() => readFileSync(`${file}.owner-v1.json`)).toThrow()
})

it('does not initialize an acknowledged database that has become zero bytes', () => {
  const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
  journal.record(event)
  expect(journal.flush()).toBe(true)
  writeFileSync(file, '')
  journal.record({ ...event, launchedAt: 101 })
  expect(journal.flush()).toBe(false)
  expect(readFileSync(file)).toHaveLength(0)
  expect(journal.snapshot()).toMatchObject({ unavailable: true, pending: true })
})

it('does not recreate a missing acknowledged database', () => {
  prepareRecipeJournalOwner(file, PROFILE, true)
  markRecipeJournalReady(file, PROFILE)
  const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
  journal.record(event)
  expect(journal.flush()).toBe(false)
  expect(() => readFileSync(file)).toThrow()
})

it('retains pending acknowledgement when the ready-marker flush fails after COMMIT', () => {
  const original = secureFile.fsyncFileSync
  let failReady = true
  vi.spyOn(secureFile, 'fsyncFileSync').mockImplementation((path) => {
    if (path.endsWith('.ready-v1.json') && failReady) {
      failReady = false
      throw new Error('Synthetic readiness flush failure')
    }
    return original(path)
  })
  const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
  journal.record(event)
  expect(journal.flush()).toBe(false)
  expect(journal.snapshot()).toMatchObject({
    pending: true,
    recipes: [{ providerSession: { id: 'original-conversation' } }]
  })
  expect(journal.flush()).toBe(true)
  expect(journal.snapshot()).toMatchObject({ pending: false })
  expect(journal.snapshot().recipes).toHaveLength(1)
})
