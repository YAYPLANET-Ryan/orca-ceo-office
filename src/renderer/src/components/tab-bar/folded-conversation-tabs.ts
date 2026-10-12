import type { AppState } from '@/store/types'
import type { TabBarItem } from './tab-bar-item-model'

type Evidence = Pick<
  AppState,
  | 'sleepingAgentSessionsByPaneKey'
  | 'paneForegroundAgentByPaneKey'
  | 'terminalLayoutsByTabId'
  | 'agentStatusByPaneKey'
  | 'pendingStartupByTabId'
>

export function canFoldConversationTab(
  item: TabBarItem,
  activeTabId: string | null,
  state: Evidence
): boolean {
  if (item.type !== 'terminal' || item.id === activeTabId || item.isPinned || item.data.isPinned) {
    return false
  }
  if (state.pendingStartupByTabId[item.id]) {
    return false
  }
  const root = state.terminalLayoutsByTabId[item.id]?.root
  // Why: never hide a mixed split tab or an unknown layout based on one finished agent.
  if (root?.type !== 'leaf') {
    return false
  }
  const key = `${item.id}:${root.leafId}`
  const record = state.sleepingAgentSessionsByPaneKey[key]
  const foreground = state.paneForegroundAgentByPaneKey[key]
  const status = state.agentStatusByPaneKey[key]
  return (
    record?.requiresManualResume === true &&
    !record.automaticResumeBlockedBy &&
    record.worktreeId === item.data.worktreeId &&
    foreground?.shellForeground === true &&
    !foreground.agent &&
    !foreground.routingConfirmationPending &&
    (!status || status.state === 'done')
  )
}
