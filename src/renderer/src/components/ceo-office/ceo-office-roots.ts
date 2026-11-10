/** Choosing the root that CEO Office entry paths are relative to.
 *
 *  Entry paths in the manifest are relative to the ORCA repository root, but the
 *  component used to resolve them against whatever workspace happened to be
 *  active. Clicking an entry activates that entry's own workspace, so the very
 *  next click resolved against the wrong root — after opening Personal, OilDealer
 *  pointed at E:/ORCA/02_PERSONAL/02_BUSINESSES/oildealer, and the manifest read
 *  fell back to the built-in default because .orca/ceo-office.json does not exist
 *  down there. The catalog only worked from the root workspace.
 */

/** Windows paths differ in slash direction and case between the repo record and
 *  the worktree path; compare on a single normalized form. */
export function normalizeRootPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export type CeoOfficeManifestCandidate = { worktreeId: string; root: string }

/** Workspaces to try, in the order worth trying.
 *
 *  Candidates are workspaces rather than bare paths because a remote read is
 *  addressed by workspace: the runtime resolves the relative path against the
 *  workspace id it is given and ignores the absolute path entirely. Passing five
 *  roots with one workspace id therefore probed the same file five times — on a
 *  paired client every attempt reported
 *  `ENOENT ... E:\ORCA\02_PERSONAL\.orca\ceo-office.json`, whichever root was asked
 *  for, because 02_PERSONAL happened to be active.
 *
 *  The active workspace comes first so an unchanged setup reads exactly one file.
 *  The rest follow outermost first: catalog entries open as their own workspaces
 *  beneath the ORCA repository, so the repository root is always the shorter path.
 */
export function ceoOfficeManifestRootCandidates(args: {
  activeWorktreeId?: string
  activeRoot?: string
  worktrees: readonly { id: string; path: string }[]
}): CeoOfficeManifestCandidate[] {
  const ordered = [...args.worktrees].sort(
    (a, b) => normalizeRootPath(a.path).length - normalizeRootPath(b.path).length
  )
  const active =
    args.activeWorktreeId && args.activeRoot
      ? [{ worktreeId: args.activeWorktreeId, root: args.activeRoot }]
      : []
  const seen = new Set<string>()
  const candidates: CeoOfficeManifestCandidate[] = []
  for (const candidate of [
    ...active,
    ...ordered.map((worktree) => ({ worktreeId: worktree.id, root: worktree.path }))
  ]) {
    if (!candidate.worktreeId || !candidate.root) {
      continue
    }
    const key = `${candidate.worktreeId}\u0000${normalizeRootPath(candidate.root)}`
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    candidates.push(candidate)
  }
  return candidates
}

/** True when `folderPath` is already registered as a project.
 *
 *  Adding a folder activates its workspace, and that activation opens a terminal
 *  on its own. Opening another one there would double up on the first click, so
 *  the extra terminal is only for revisits.
 */
export function isFolderAlreadyRegistered(args: {
  folderPath: string
  repoPaths: readonly string[]
}): boolean {
  const key = normalizeRootPath(args.folderPath)
  return args.repoPaths.some((path) => normalizeRootPath(path) === key)
}
