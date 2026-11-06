import type { Store } from '../../../persistence'
import type { PtySpawnResult } from '../../../providers/types'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { layoutContainsLeafId } from '../../../persistence/restoring-sessions/terminal-layout-normalization'

export function matchesPersistedPaneAttachment(
  session: ReturnType<Store['getWorkspaceSession']>,
  args: {
    worktreeId: string
    tabId: string
    leafId: string
    result: Pick<PtySpawnResult, 'id' | 'incarnationId'>
  }
): boolean {
  const paneKey = makePaneKey(args.tabId, args.leafId)
  const layout = session.terminalLayoutsByTabId?.[args.tabId]
  return Boolean(
    args.result.incarnationId &&
    session.tabsByWorktree?.[args.worktreeId]?.some(
      (tab) => tab.id === args.tabId && tab.worktreeId === args.worktreeId
    ) &&
    layoutContainsLeafId(layout?.root ?? null, args.leafId) &&
    !session.terminalSurfaceTombstonesByPaneKey?.[paneKey] &&
    layout?.ptyIdsByLeafId?.[args.leafId] === args.result.id &&
    session.terminalPtyIncarnationsByPaneKey?.[paneKey] === args.result.incarnationId
  )
}
