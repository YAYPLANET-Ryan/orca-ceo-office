import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Store } from '../../../persistence'
import { advanceTerminalTopologyRevision } from '../../../runtime/workspace-session-terminal-membership-authority'
import type { StablePaneOwner } from './stable-owner'

export function clearStablePaneBinding(
  store: Store | undefined,
  owner: StablePaneOwner,
  worktreeId: string,
  connectionId: string | null | undefined,
  resolveCurrent: () => Pick<StablePaneOwner, 'tabId' | 'leafId' | 'ptyId' | 'incarnationId'> | null
): boolean {
  if (!store) {
    return false
  }
  const paneKey = makePaneKey(owner.tabId, owner.leafId)
  const hostId = connectionId ? toSshExecutionHostId(connectionId) : undefined
  const current = resolveCurrent()
  if (!current) {
    // Why: persistence already dropped this pane binding (an earlier stop retired it while the
    // runtime kept history), so there is nothing left to clear — that is a completed retirement,
    // not a competing owner. Reporting failure here strands the pane after its PTY is proven dead.
    return true
  }
  if (current.ptyId !== owner.ptyId || current.incarnationId !== owner.persistedIncarnationId) {
    return false
  }
  const session = store.getWorkspaceSession(hostId)
  const layout = session.terminalLayoutsByTabId[owner.tabId]
  const bindings = { ...layout.ptyIdsByLeafId }
  delete bindings[owner.leafId]
  const incarnations = { ...session.terminalPtyIncarnationsByPaneKey }
  delete incarnations[paneKey]
  // Why: a failed reattach revokes a process binding, not the user's tab or resume identity.
  store.setWorkspaceSession(
    advanceTerminalTopologyRevision(
      {
        ...session,
        tabsByWorktree: {
          ...session.tabsByWorktree,
          [worktreeId]: session.tabsByWorktree[worktreeId].map((tab) =>
            tab.id === owner.tabId && tab.ptyId === owner.ptyId ? { ...tab, ptyId: null } : tab
          )
        },
        terminalLayoutsByTabId: {
          ...session.terminalLayoutsByTabId,
          [owner.tabId]: { ...layout, ptyIdsByLeafId: bindings }
        },
        terminalPtyIncarnationsByPaneKey: incarnations
      },
      worktreeId
    ),
    hostId
  )
  store.flushOrThrow()
  return true
}
