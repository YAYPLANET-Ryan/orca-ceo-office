/** What clicking a CEO Office catalog entry should do.
 *
 *  Kept separate from the component so the decision is testable without a render:
 *  the branch used to end in a throw for every local workspace, which meant a
 *  click did nothing at all and nothing caught it.
 */
export type CeoOfficeNavigationAction =
  /** An SSH terminal is already live on the right host — move it rather than
   *  spawning a second remote shell. */
  | { kind: 'ssh-cd'; ptyId: string; command: string }
  /** Local: register the entry as a folder-backed project and activate it, so the
   *  business gets its own sidebar entry with its own tabs. */
  | { kind: 'folder-workspace'; folderPath: string }
  /** Nothing to open: the entry labels a section rather than a working folder. */
  | { kind: 'none' }

export function resolveCeoOfficeNavigation(args: {
  itemPath: string
  itemKind?: 'section' | 'task' | 'folder'
  connectionId?: string | null
  activePtyId?: string | null
}): CeoOfficeNavigationAction {
  const { itemPath, itemKind, connectionId, activePtyId } = args
  // A 'section' entry is a heading for a review or approval area, not a project
  // root. Registering one was never intended: 05_REVIEW has no folder on disk and
  // failed with a toast, while 05_APPROVED does have one and would quietly become
  // a project alongside the businesses.
  if (itemKind === 'section') {
    return { kind: 'none' }
  }
  if (connectionId && activePtyId?.startsWith(`ssh:${connectionId}@@`)) {
    // Single quotes are the PowerShell literal-string escape, doubled to embed one.
    const escapedPath = itemPath.replaceAll("'", "''")
    return {
      kind: 'ssh-cd',
      ptyId: activePtyId,
      command: `Set-Location -LiteralPath '${escapedPath}'\r`
    }
  }
  // Why a folder-kind registration rather than a tab in the current workspace:
  // each catalog entry is a project/session root, and giving it its own workspace
  // is what keeps its tabs, agents and status separate from every other business.
  //
  // Folder-kind adds are safe to repeat. The add handler dedupes on the normalized
  // path and, unlike a git-kind add, does not resolve the path to the enclosing
  // repository root — so a second click reuses the existing project instead of
  // registering the ORCA repo again under a fresh id.
  return { kind: 'folder-workspace', folderPath: itemPath }
}
