import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import Database from '../../sqlite/sync-database'
import { hardenSqliteDatabaseFiles } from '../../sqlite/harden-database-files'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import type { LaunchResumeIdentityEvent } from './launch-resume-identity-event'
import {
  decodeResumeLaunchRecipe,
  isValidResumeRecipeClosure,
  projectResumeLaunchRecipe,
  resumeLaunchRecipeKey,
  type UnverifiedResumeLaunchRecipe
} from './resume-launch-recipe'
import {
  inspectOwnedRecipeJournal,
  hasAcknowledgedRecipeJournal,
  isRecipeReadonlyRollback,
  markRecipeJournalReady,
  prepareRecipeJournalFile,
  RECIPE_JOURNAL_APPLICATION_ID,
  validateRecipeJournalOwner,
  validateRecipeJournalCreationTarget
} from './resume-recipe-journal-owner'

const MAX_RECIPES = 1024
const TABLE_SQL = `CREATE TABLE resume_recipes (
  recipe_key TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  closed_at INTEGER
)`

type RecipeEntry = { recipe: UnverifiedResumeLaunchRecipe; closedAt?: number }

/** Separate from status caches and provider authority; a full journal never evicts original IDs. */
export class ResumeLaunchRecipeJournal {
  private readonly pending = new Map<string, RecipeEntry>()
  private readonly pendingClosures = new Map<string, number>()
  private closureCapacityExceeded = false
  private refusal: 'none' | 'invalid-input' | 'capacity' | 'storage-unavailable' = 'none'

  get lastRefusal() {
    return this.refusal
  }

  get hasPending(): boolean {
    return this.pending.size > 0 || this.pendingClosures.size > 0 || this.closureCapacityExceeded
  }

  belongsTo(file: string, profileId: string): boolean {
    return this.file === file && this.profileId === profileId
  }

  constructor(
    private readonly file: string,
    private readonly profileId: string
  ) {
    if (!isAbsolute(file) || !/^[a-f0-9]{64}$/.test(profileId)) {
      throw new Error('Invalid resume recipe journal namespace')
    }
  }

  record(event: LaunchResumeIdentityEvent): boolean {
    const recipe = projectResumeLaunchRecipe(event)
    if (!recipe) {
      this.refusal = 'invalid-input'
      return false
    }
    const key = resumeLaunchRecipeKey(recipe)
    if (!this.pending.has(key) && this.pending.size >= MAX_RECIPES) {
      this.refusal = 'capacity'
      return false
    }
    this.pending.set(key, this.pending.get(key) ?? { recipe })
    this.refusal = this.closureCapacityExceeded ? 'capacity' : 'none'
    return true
  }

  snapshot(paneKey?: string) {
    const entries = new Map<string, RecipeEntry>()
    let unavailable = false
    try {
      for (const entry of this.readSaved()) {
        entries.set(resumeLaunchRecipeKey(entry.recipe), entry)
      }
    } catch {
      unavailable = true
    }
    for (const [key, entry] of this.pending) {
      const closedAt = Math.max(entries.get(key)?.closedAt ?? 0, entry.closedAt ?? 0)
      entries.set(key, { ...entry, ...(closedAt > 0 ? { closedAt } : {}) })
    }
    return {
      unavailable: unavailable || this.closureCapacityExceeded,
      pending: this.hasPending,
      recipes: [...entries.values()]
        .filter(({ recipe }) => paneKey === undefined || recipe.paneKey === paneKey)
        .map(({ recipe, closedAt }) => {
          const closure = this.pendingClosures.get(parsePaneKey(recipe.paneKey)?.tabId ?? '')
          const effectiveClosure =
            closedAt ?? (closure !== undefined && closure >= recipe.launchedAt ? closure : 0)
          return {
            ...recipe,
            providerSession: { ...recipe.providerSession },
            ...(effectiveClosure > 0 ? { closedAt: effectiveClosure } : {})
          }
        })
    }
  }

  markTabClosed(tabId: string, closedAt: number): boolean {
    if (!isValidResumeRecipeClosure(tabId, closedAt)) {
      return false
    }
    if (!this.pendingClosures.has(tabId) && this.pendingClosures.size >= MAX_RECIPES) {
      this.closureCapacityExceeded = true
      this.refusal = 'capacity'
      return false
    }
    this.pendingClosures.set(tabId, Math.max(closedAt, this.pendingClosures.get(tabId) ?? 0))
    return this.flush()
  }

  flush(): boolean {
    if (this.pending.size === 0 && this.pendingClosures.size === 0) {
      try {
        this.readSaved()
        if (existsSync(this.file)) {
          markRecipeJournalReady(this.file, this.profileId)
        }
        this.refusal = this.closureCapacityExceeded ? 'capacity' : 'none'
        return !this.closureCapacityExceeded
      } catch (error) {
        try {
          const state = inspectOwnedRecipeJournal(this.file, this.profileId)
          if (state !== 'initialize' && !isRecipeReadonlyRollback(error)) {
            throw error
          }
        } catch {
          this.refusal = 'storage-unavailable'
          return false
        }
      }
    }
    let db: Database | undefined
    try {
      const existed = existsSync(this.file)
      if (existed) {
        const state = inspectOwnedRecipeJournal(this.file, this.profileId)
        if (state === 'ready') {
          try {
            this.readSaved()
          } catch (error) {
            if (!isRecipeReadonlyRollback(error)) {
              throw error
            }
          }
        }
      }
      prepareRecipeJournalFile(this.file, this.profileId)
      db = new Database(this.file, { timeout: 500 })
      db.pragma('synchronous = FULL')
      db.exec('BEGIN IMMEDIATE')
      const version = Number(db.pragma('user_version', { simple: true }))
      const application = Number(db.pragma('application_id', { simple: true }))
      if (
        version === 0 &&
        !hasAcknowledgedRecipeJournal(this.file, this.profileId) &&
        (application === 0 || application === RECIPE_JOURNAL_APPLICATION_ID)
      ) {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
        if (tables.length > 0) {
          throw new Error('Unexpected resume recipe schema')
        }
        db.exec(TABLE_SQL)
        db.pragma('user_version = 1')
        db.pragma(`application_id = ${RECIPE_JOURNAL_APPLICATION_ID}`)
      } else if (version !== 1 || application !== RECIPE_JOURNAL_APPLICATION_ID) {
        throw new Error('Unsupported resume recipe schema')
      }
      const savedRows = this.readRows(db)
      let count = Number(db.prepare('SELECT count(*) AS count FROM resume_recipes').get()?.count)
      const committedKeys: string[] = []
      for (const [key, entry] of this.pending) {
        const existing = db
          .prepare('SELECT metadata_json, closed_at FROM resume_recipes WHERE recipe_key=?')
          .get(key)
        const json = JSON.stringify(entry.recipe)
        if (existing && existing.metadata_json !== json) {
          throw new Error('Resume recipe identity conflict')
        }
        if (!existing) {
          if (count >= MAX_RECIPES) {
            continue
          }
          db.prepare('INSERT INTO resume_recipes VALUES(?,?,?,?)').run(
            key,
            this.profileId,
            json,
            entry.closedAt ?? null
          )
          count++
        }
        committedKeys.push(key)
      }
      for (const { recipe } of [...savedRows, ...this.pending.values()]) {
        const closedAt = this.pendingClosures.get(parsePaneKey(recipe.paneKey)?.tabId ?? '')
        if (closedAt !== undefined && closedAt >= recipe.launchedAt) {
          db.prepare(
            'UPDATE resume_recipes SET closed_at=COALESCE(closed_at,?) WHERE recipe_key=?'
          ).run(closedAt, resumeLaunchRecipeKey(recipe))
        }
      }
      db.exec('COMMIT')
      hardenSqliteDatabaseFiles(this.file)
      markRecipeJournalReady(this.file, this.profileId)
      for (const key of committedKeys) {
        this.pending.delete(key)
      }
      const unresolvedTabs = new Set(
        [...this.pending.values()].map(({ recipe }) => parsePaneKey(recipe.paneKey)?.tabId)
      )
      for (const tabId of this.pendingClosures.keys()) {
        if (!unresolvedTabs.has(tabId)) {
          this.pendingClosures.delete(tabId)
        }
      }
      this.refusal = this.pending.size > 0 || this.closureCapacityExceeded ? 'capacity' : 'none'
      return this.pending.size === 0 && !this.closureCapacityExceeded
    } catch {
      this.refusal = 'storage-unavailable'
      if (db?.isTransaction) {
        try {
          db.exec('ROLLBACK')
        } catch {}
      }
      return false
    } finally {
      db?.close()
    }
  }

  private readSaved(): RecipeEntry[] {
    if (!existsSync(this.file)) {
      validateRecipeJournalCreationTarget(this.file)
      if (existsSync(`${this.file}.owner-v1.json`)) {
        validateRecipeJournalOwner(this.file, this.profileId)
      }
      return []
    }
    if (inspectOwnedRecipeJournal(this.file, this.profileId) !== 'ready') {
      throw new Error('Resume recipe journal initialization incomplete')
    }
    const db = new Database(this.file, { readonly: true, fileMustExist: true, timeout: 500 })
    try {
      if (
        Number(db.pragma('user_version', { simple: true })) !== 1 ||
        Number(db.pragma('application_id', { simple: true })) !== RECIPE_JOURNAL_APPLICATION_ID
      ) {
        throw new Error('Unsupported resume recipe schema')
      }
      return this.readRows(db)
    } finally {
      db.close()
    }
  }

  private readRows(db: Database): RecipeEntry[] {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()
    const columns = db
      .prepare('PRAGMA table_info(resume_recipes)')
      .all()
      .map(({ name }) => name)
    const triggers = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all()
    if (
      tables.length !== 1 ||
      tables[0]?.name !== 'resume_recipes' ||
      columns.join(',') !== 'recipe_key,profile_id,metadata_json,closed_at' ||
      triggers.length > 0
    ) {
      throw new Error('Unsupported resume recipe table layout')
    }
    const rows = db
      .prepare('SELECT recipe_key,profile_id,metadata_json,closed_at FROM resume_recipes LIMIT ?')
      .all(MAX_RECIPES + 1)
    if (rows.length > MAX_RECIPES) {
      throw new Error('Resume recipe journal is full')
    }
    return rows.map((row) => {
      if (row.profile_id !== this.profileId || typeof row.metadata_json !== 'string') {
        throw new Error('Foreign or malformed resume recipe')
      }
      const recipe = decodeResumeLaunchRecipe(row.metadata_json)
      if (row.recipe_key !== resumeLaunchRecipeKey(recipe)) {
        throw new Error('Resume recipe key mismatch')
      }
      if (row.closed_at === null) {
        return { recipe }
      }
      if (
        typeof row.closed_at !== 'number' ||
        !Number.isSafeInteger(row.closed_at) ||
        row.closed_at <= 0
      ) {
        throw new Error('Invalid resume recipe closure')
      }
      return { recipe, closedAt: row.closed_at }
    })
  }
}
