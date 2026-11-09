import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import Database from '../../sqlite/sync-database'
import { ResumeLaunchRecipeJournal } from './resume-launch-recipe-journal'
import { decodeResumeLaunchRecipe, projectResumeLaunchRecipe } from './resume-launch-recipe'
import type { LaunchResumeIdentityEvent } from './launch-resume-identity-event'

const PROFILE = 'a'.repeat(64)
const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const event: LaunchResumeIdentityEvent = {
  paneKey: PANE,
  worktreeId: 'workspace-a',
  agentType: 'codex',
  providerSession: { key: 'session_id', id: 'original-conversation', cwd: '/workspace-a' },
  launchedAt: 100
}
let root: string
let file: string

it('refuses whitespace workspace identifiers on both request and stored metadata paths', () => {
  const malformed = { ...event, worktreeId: ' workspace-a' }
  expect(projectResumeLaunchRecipe(malformed)).toBeNull()
  expect(() =>
    decodeResumeLaunchRecipe(JSON.stringify({ verification: 'unverified', ...malformed }))
  ).toThrow()
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-resume-recipe-journal-'))
  file = join(root, 'resume-recipes-v1.sqlite')
})

afterEach(() => {
  vi.restoreAllMocks()
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith('orca-resume-recipe-journal-')
  ) {
    throw new Error('Refusing cleanup outside own recipe fixture')
  }
  rmSync(root, { recursive: true, force: true })
})

it('preserves a quiet resume ID through a new journal instance without asserting ownership', () => {
  const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
  expect(journal.record(event)).toBe(true)
  expect(journal.flush()).toBe(true)
  expect(new ResumeLaunchRecipeJournal(file, PROFILE).snapshot(PANE)).toMatchObject({
    unavailable: false,
    pending: false,
    recipes: [{ verification: 'unverified', providerSession: { id: 'original-conversation' } }]
  })
})

it('does not create a journal during an empty history read', () => {
  expect(new ResumeLaunchRecipeJournal(file, PROFILE).snapshot()).toEqual({
    unavailable: false,
    pending: false,
    recipes: []
  })
  expect(() => readFileSync(file)).toThrow()
})

it('merges independently buffered writers instead of overwriting the first ID', () => {
  const first = new ResumeLaunchRecipeJournal(file, PROFILE)
  const second = new ResumeLaunchRecipeJournal(file, PROFILE)
  first.record(event)
  second.record({ ...event, providerSession: { key: 'session_id', id: 'second-conversation' } })
  expect(first.flush()).toBe(true)
  expect(second.flush()).toBe(true)
  expect(
    first
      .snapshot()
      .recipes.map(({ providerSession }) => providerSession.id)
      .sort()
  ).toEqual(['original-conversation', 'second-conversation'])
})

it('keeps the pending ID when a concurrent database writer holds the lock, then retries', () => {
  const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
  journal.record(event)
  expect(journal.flush()).toBe(true)
  const writer = new Database(file)
  try {
    writer.exec('BEGIN IMMEDIATE')
    journal.record({ ...event, launchedAt: 101 })
    expect(journal.flush()).toBe(false)
    expect(journal.snapshot().pending).toBe(true)
    writer.exec('ROLLBACK')
    expect(journal.flush()).toBe(true)
    expect(journal.snapshot().recipes).toHaveLength(2)
  } finally {
    if (writer.isTransaction) {
      writer.exec('ROLLBACK')
    }
    writer.close()
  }
})

it.each(['corrupt', 'newer', 'foreign-profile', 'unknown-layout'] as const)(
  'preserves %s journal bytes and failed-write memory',
  (kind) => {
    const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
    if (kind === 'corrupt') {
      writeFileSync(file, 'synthetic-corrupt-database')
    } else {
      journal.record(event)
      expect(journal.flush()).toBe(true)
      if (kind === 'newer') {
        const db = new Database(file)
        db.pragma('user_version = 2')
        db.close()
      } else if (kind === 'unknown-layout') {
        const db = new Database(file)
        db.exec('CREATE TABLE future_metadata (value TEXT)')
        db.close()
      }
    }
    const before = readFileSync(file)
    const refused = new ResumeLaunchRecipeJournal(
      file,
      kind === 'foreign-profile' ? 'b'.repeat(64) : PROFILE
    )
    refused.record({ ...event, launchedAt: 102 })
    expect(refused.flush()).toBe(false)
    expect(refused.snapshot()).toMatchObject({ unavailable: true, pending: true })
    expect(readFileSync(file)).toEqual(before)
  }
)

it('retains closed history and its tombstone across a duplicate launch retry', () => {
  const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
  journal.record(event)
  expect(journal.flush()).toBe(true)
  expect(journal.markTabClosed('tab-1', 200)).toBe(true)
  journal.record(event)
  expect(journal.snapshot().recipes[0]?.closedAt).toBe(200)
  expect(journal.flush()).toBe(true)
  expect(new ResumeLaunchRecipeJournal(file, PROFILE).snapshot().recipes[0]?.closedAt).toBe(200)
})

it('does not call an unreadable journal healthy merely because no new write is pending', () => {
  writeFileSync(file, 'synthetic-corrupt-database')
  expect(new ResumeLaunchRecipeJournal(file, PROFILE).flush()).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe('synthetic-corrupt-database')
})

it('rolls back a failed COMMIT and retains the unacknowledged ID for retry', () => {
  const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
  journal.record(event)
  expect(journal.flush()).toBe(true)
  journal.record({ ...event, providerSession: { key: 'session_id', id: 'pending-conversation' } })
  const originalExec = Database.prototype.exec
  let failCommit = true
  vi.spyOn(Database.prototype, 'exec').mockImplementation(function (this: Database, sql: string) {
    if (sql === 'COMMIT' && failCommit) {
      failCommit = false
      throw new Error('Synthetic commit failure')
    }
    return originalExec.call(this, sql)
  })
  expect(journal.flush()).toBe(false)
  expect(
    new ResumeLaunchRecipeJournal(file, PROFILE)
      .snapshot()
      .recipes.map(({ providerSession }) => providerSession.id)
  ).toEqual(['original-conversation'])
  expect(journal.snapshot().pending).toBe(true)
  expect(journal.flush()).toBe(true)
  expect(new ResumeLaunchRecipeJournal(file, PROFILE).snapshot().recipes).toHaveLength(2)
})

it('refuses capacity without evicting original durable IDs', () => {
  const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
  for (let index = 0; index < 1024; index++) {
    journal.record({ ...event, launchedAt: index + 1 })
  }
  expect(journal.flush()).toBe(true)
  journal.record({ ...event, launchedAt: 1025 })
  expect(journal.flush()).toBe(false)
  expect(new ResumeLaunchRecipeJournal(file, PROFILE).snapshot().recipes).toHaveLength(1024)
  expect(journal.snapshot().pending).toBe(true)
  expect(journal.lastRefusal).toBe('capacity')
  expect(journal.markTabClosed('tab-1', 2000)).toBe(false)
  const closed = new ResumeLaunchRecipeJournal(file, PROFILE).snapshot().recipes
  expect(closed).toHaveLength(1024)
  expect(closed.every(({ closedAt }) => closedAt === 2000)).toBe(true)
  expect(journal.lastRefusal).toBe('capacity')
})

it('projects no capabilities, environment, command or conversation body into stored recipes', () => {
  const journal = new ResumeLaunchRecipeJournal(file, PROFILE)
  const withPrivateFields = {
    ...event,
    launchToken: 'synthetic-capability',
    command: 'synthetic-command',
    prompt: 'synthetic-body',
    agentEnv: { private: 'synthetic-env' }
  }
  journal.record(withPrivateFields)
  expect(journal.flush()).toBe(true)
  const stored = readFileSync(file).toString()
  for (const privateValue of [
    'synthetic-capability',
    'synthetic-command',
    'synthetic-body',
    'synthetic-env'
  ]) {
    expect(stored).not.toContain(privateValue)
  }
})

it.each([{ id: ' original-conversation ' }, { id: 'original-conversation', cwd: '/invalid\0cwd' }])(
  'refuses lossy metadata normalization',
  (providerSession) => {
    expect(
      projectResumeLaunchRecipe({
        ...event,
        providerSession: { key: 'session_id', ...providerSession }
      })
    ).toBeNull()
  }
)

it.each(['claude', 'codex'])(
  'round-trips %s metadata without changing its resume locator',
  (agentType) => {
    const recipe = projectResumeLaunchRecipe({
      ...event,
      agentType,
      providerSession: {
        ...event.providerSession,
        transcriptPath: '/workspace-a/history.jsonl',
        effort: 'high'
      }
    })
    if (!recipe) {
      throw new Error('Valid isolated recipe was refused')
    }
    expect(decodeResumeLaunchRecipe(JSON.stringify(recipe))).toEqual({
      verification: 'unverified',
      paneKey: PANE,
      worktreeId: 'workspace-a',
      agentType,
      providerSession: {
        key: 'session_id',
        id: 'original-conversation',
        transcriptPath: '/workspace-a/history.jsonl',
        cwd: '/workspace-a',
        effort: 'high'
      },
      launchedAt: 100
    })
  }
)

it('refuses metadata whose UTF-8 bytes would exceed the persisted recipe limit', () => {
  expect(
    projectResumeLaunchRecipe({
      ...event,
      providerSession: { ...event.providerSession, cwd: '가'.repeat(6000) }
    })
  ).toBeNull()
})
