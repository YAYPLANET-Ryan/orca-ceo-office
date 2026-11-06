import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { canFoldConversationTab } from './folded-conversation-tabs'
import type { TabBarItem } from './tab-bar-item-model'

export function useFoldedConversationTabs(items: TabBarItem[], activeTabId: string | null) {
  const [showAll, setShowAll] = useState(false)
  const evidence = useAppStore(
    useShallow((s) => ({
      sleepingAgentSessionsByPaneKey: s.sleepingAgentSessionsByPaneKey,
      paneForegroundAgentByPaneKey: s.paneForegroundAgentByPaneKey,
      terminalLayoutsByTabId: s.terminalLayoutsByTabId,
      agentStatusByPaneKey: s.agentStatusByPaneKey,
      pendingStartupByTabId: s.pendingStartupByTabId
    }))
  )
  const candidates = items.filter((item) => canFoldConversationTab(item, activeTabId, evidence))
  const foldedIds = new Set(showAll ? [] : candidates.map((item) => item.id))
  return {
    visibleItems: items.filter((item) => !foldedIds.has(item.id)),
    foldedItems: candidates,
    showAll,
    setShowAll
  }
}
