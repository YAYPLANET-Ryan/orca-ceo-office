import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'
import {
  bestEffortFsyncDirectorySync,
  fsyncFileSync
} from '../../../shared/secure-storage/secure-file'

export const RECIPE_JOURNAL_APPLICATION_ID = 0x4f52524a
export const RECIPE_JOURNAL_MAX_FILE_BYTES = 64 * 1024 * 1024
// Markers this process already validated and fsynced; later saves still re-validate content but skip the
// file and directory fsync that each per-launch save would otherwise repeat (main-sync-fs hot path).
const durableMarkers = new Set<string>()

export function validateRecipeJournalCreationTarget(file: string): void {
  const target = lstatSync(file, { throwIfNoEntry: false })
  if (target && (!target.isFile() || target.isSymbolicLink())) {
    throw new Error('Invalid resume recipe creation target')
  }
  if (!target && lstatSync(`${file}.ready-v1.json`, { throwIfNoEntry: false })) {
    throw new Error('An acknowledged resume recipe journal is missing')
  }
  if (
    !target &&
    ['-journal', '-wal', '-shm'].some((suffix) =>
      lstatSync(`${file}${suffix}`, { throwIfNoEntry: false })
    )
  ) {
    throw new Error('Orphaned resume recipe sidecars require review')
  }
}

export function prepareRecipeJournalFile(file: string, profileId: string): void {
  validateRecipeJournalCreationTarget(file)
  prepareRecipeJournalOwner(file, profileId, !existsSync(file))
  if (!existsSync(file)) {
    try {
      closeSync(openSync(file, 'wx', 0o600))
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
        throw error
      }
    }
  }
}

function markerText(profileId: string, kind: string): string {
  return JSON.stringify({ version: 1, kind, profileId })
}

function validateMarker(marker: string, profileId: string, kind: string): void {
  const stat = lstatSync(marker)
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size > 1024 ||
    readFileSync(marker, 'utf8') !== markerText(profileId, kind)
  ) {
    throw new Error('Unrecognized resume recipe journal owner')
  }
}

function prepareMarker(
  marker: string,
  profileId: string,
  kind: string,
  allowCreate: boolean
): void {
  const durableKey = JSON.stringify([marker, profileId, kind])
  if (!existsSync(marker)) {
    durableMarkers.delete(durableKey)
    if (!allowCreate) {
      throw new Error('Resume recipe journal owner is missing')
    }
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 })
    const temporary = `${marker}.${randomUUID()}.tmp`
    try {
      const descriptor = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(descriptor, markerText(profileId, kind))
        fsyncSync(descriptor)
      } finally {
        closeSync(descriptor)
      }
      try {
        linkSync(temporary, marker)
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
          throw error
        }
      }
    } finally {
      try {
        unlinkSync(temporary)
      } catch {}
    }
  }
  validateMarker(marker, profileId, kind)
  if (durableMarkers.has(durableKey)) {
    return
  }
  fsyncFileSync(marker)
  bestEffortFsyncDirectorySync(dirname(marker))
  durableMarkers.add(durableKey)
}

export function validateRecipeJournalOwner(file: string, profileId: string): void {
  validateMarker(`${file}.owner-v1.json`, profileId, 'orca-unverified-resume-recipes')
  if (lstatSync(`${file}.ready-v1.json`, { throwIfNoEntry: false })) {
    validateMarker(`${file}.ready-v1.json`, profileId, 'orca-unverified-resume-recipes-ready')
  }
}

export function hasAcknowledgedRecipeJournal(file: string, profileId: string): boolean {
  validateRecipeJournalOwner(file, profileId)
  return !!lstatSync(`${file}.ready-v1.json`, { throwIfNoEntry: false })
}

export function prepareRecipeJournalOwner(
  file: string,
  profileId: string,
  allowCreate: boolean
): void {
  prepareMarker(`${file}.owner-v1.json`, profileId, 'orca-unverified-resume-recipes', allowCreate)
  if (lstatSync(`${file}.ready-v1.json`, { throwIfNoEntry: false })) {
    markRecipeJournalReady(file, profileId)
  }
}

export function markRecipeJournalReady(file: string, profileId: string): void {
  validateRecipeJournalOwner(file, profileId)
  prepareMarker(`${file}.ready-v1.json`, profileId, 'orca-unverified-resume-recipes-ready', true)
}

function readPrefix(file: string, size: number): Buffer {
  const header = Buffer.alloc(size)
  const descriptor = openSync(file, 'r')
  try {
    if (readSync(descriptor, header, 0, size, 0) !== size) {
      throw new Error('Incomplete recipe journal header')
    }
    return header
  } finally {
    closeSync(descriptor)
  }
}

function isInitialRollback(file: string): boolean {
  try {
    const journal = `${file}-journal`
    const stat = lstatSync(journal)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RECIPE_JOURNAL_MAX_FILE_BYTES) {
      return false
    }
    const header = readPrefix(journal, 28)
    const sector = header.readUInt32BE(20)
    const page = header.readUInt32BE(24)
    const powerOfTwo = (size: number) => size >= 512 && size <= 65536 && (size & (size - 1)) === 0
    return (
      header.subarray(0, 8).equals(Buffer.from('d9d505f920a163d7', 'hex')) &&
      header.readUInt32BE(16) === 0 &&
      powerOfTwo(sector) &&
      powerOfTwo(page) &&
      stat.size >= sector
    )
  } catch {
    return false
  }
}

/** Header checks only refuse formats; SQLite must revalidate recovered schema and profile under lock. */
export function inspectOwnedRecipeJournal(file: string, profileId: string): 'initialize' | 'ready' {
  validateRecipeJournalOwner(file, profileId)
  if (existsSync(`${file}-wal`) || existsSync(`${file}-shm`)) {
    throw new Error('Unsupported recipe journal mode')
  }
  const stat = lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RECIPE_JOURNAL_MAX_FILE_BYTES) {
    throw new Error('Invalid recipe journal file')
  }
  const acknowledged = hasAcknowledgedRecipeJournal(file, profileId)
  if (stat.size === 0) {
    if (acknowledged) {
      throw new Error('Acknowledged recipe journal became empty')
    }
    return 'initialize'
  }
  const header = readPrefix(file, 100)
  if (!acknowledged && header.every((byte) => byte === 0) && isInitialRollback(file)) {
    return 'initialize'
  }
  if (
    header.subarray(0, 16).toString() !== 'SQLite format 3\0' ||
    header[18] !== 1 ||
    header[19] !== 1
  ) {
    throw new Error('Unrecognized recipe journal format')
  }
  const version = header.readUInt32BE(60)
  const application = header.readUInt32BE(68)
  if (version === 0 && (application === 0 || application === RECIPE_JOURNAL_APPLICATION_ID)) {
    if (acknowledged) {
      throw new Error('Acknowledged recipe journal lost its schema')
    }
    return 'initialize'
  }
  if (version === 1 && application === RECIPE_JOURNAL_APPLICATION_ID) {
    return 'ready'
  }
  throw new Error('Unsupported recipe journal schema')
}

export function isRecipeReadonlyRollback(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'errcode' in error && error.errcode === 776
}
