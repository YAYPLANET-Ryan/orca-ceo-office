import { describe, expect, it } from 'vitest'
import {
  ceoOfficeManifestRootCandidates,
  isFolderAlreadyRegistered,
  normalizeRootPath
} from './ceo-office-roots'

const WORKTREES = [
  { id: 'wt-oildealer', path: 'E:/ORCA/02_BUSINESSES/oildealer' },
  { id: 'wt-root', path: 'E:/ORCA' },
  { id: 'wt-personal', path: 'E:/ORCA/02_PERSONAL' }
]

describe('ceoOfficeManifestRootCandidates', () => {
  it('tries the active workspace first so an unchanged setup reads one file', () => {
    const [first] = ceoOfficeManifestRootCandidates({
      activeWorktreeId: 'wt-root',
      activeRoot: 'E:/ORCA',
      worktrees: WORKTREES
    })
    expect(first).toEqual({ worktreeId: 'wt-root', root: 'E:/ORCA' })
  })

  // A remote read is addressed by workspace, not by path — the runtime resolves
  // the relative path against the workspace id and ignores the absolute path. With
  // roots alone, every candidate resolved against whichever workspace was active,
  // so a paired client probed E:/ORCA/02_PERSONAL/.orca/ceo-office.json five times.
  it('pairs every root with the workspace that owns it', () => {
    const candidates = ceoOfficeManifestRootCandidates({
      activeWorktreeId: 'wt-personal',
      activeRoot: 'E:/ORCA/02_PERSONAL',
      worktrees: WORKTREES
    })
    expect(candidates).toEqual([
      { worktreeId: 'wt-personal', root: 'E:/ORCA/02_PERSONAL' },
      { worktreeId: 'wt-root', root: 'E:/ORCA' },
      { worktreeId: 'wt-oildealer', root: 'E:/ORCA/02_BUSINESSES/oildealer' }
    ])
  })

  it('orders the workspaces outermost first', () => {
    expect(ceoOfficeManifestRootCandidates({ worktrees: WORKTREES }).map((c) => c.root)).toEqual([
      'E:/ORCA',
      'E:/ORCA/02_PERSONAL',
      'E:/ORCA/02_BUSINESSES/oildealer'
    ])
  })

  it('drops duplicates across slash direction and case', () => {
    expect(
      ceoOfficeManifestRootCandidates({
        activeWorktreeId: 'wt-root',
        activeRoot: 'E:\\ORCA',
        worktrees: [{ id: 'wt-root', path: 'e:/orca/' }]
      })
    ).toEqual([{ worktreeId: 'wt-root', root: 'E:\\ORCA' }])
  })

  it('returns an empty list when nothing is known', () => {
    expect(ceoOfficeManifestRootCandidates({ worktrees: [] })).toEqual([])
  })
})

describe('isFolderAlreadyRegistered', () => {
  it.each([
    { name: 'exact', folderPath: 'E:/ORCA/02_PERSONAL' },
    { name: 'backslashes', folderPath: 'E:\\ORCA\\02_PERSONAL' },
    { name: 'different case', folderPath: 'e:/orca/02_personal' },
    { name: 'trailing slash', folderPath: 'E:/ORCA/02_PERSONAL/' }
  ])('matches a registered project: $name', ({ folderPath }) => {
    expect(
      isFolderAlreadyRegistered({ folderPath, repoPaths: ['E:/ORCA', 'E:/ORCA/02_PERSONAL'] })
    ).toBe(true)
  })

  it('does not match an unregistered folder', () => {
    expect(
      isFolderAlreadyRegistered({
        folderPath: 'E:/ORCA/02_BUSINESSES/oildealer',
        repoPaths: ['E:/ORCA', 'E:/ORCA/02_PERSONAL']
      })
    ).toBe(false)
  })

  it('does not treat the enclosing repo as a match', () => {
    expect(
      isFolderAlreadyRegistered({ folderPath: 'E:/ORCA/01_CEO_OFFICE', repoPaths: ['E:/ORCA'] })
    ).toBe(false)
  })
})

describe('normalizeRootPath', () => {
  it('collapses slash direction, trailing slashes and case', () => {
    expect(normalizeRootPath('E:\\ORCA\\')).toBe('e:/orca')
  })
})
