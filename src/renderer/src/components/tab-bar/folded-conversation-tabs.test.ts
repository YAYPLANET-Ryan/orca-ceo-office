import { expect, it } from 'vitest'
import { canFoldConversationTab } from './folded-conversation-tabs'
import type { TabBarItem } from './tab-bar-item-model'

function setup() {
  const item = {
    type: 'terminal',
    id: 'tab',
    isPinned: false,
    data: { worktreeId: 'wt' }
  } as TabBarItem
  const state = {
    sleepingAgentSessionsByPaneKey: {
      'tab:leaf': { requiresManualResume: true, worktreeId: 'wt' }
    },
    paneForegroundAgentByPaneKey: { 'tab:leaf': { agent: null, shellForeground: true } },
    terminalLayoutsByTabId: { tab: { root: { type: 'leaf', leafId: 'leaf' } } },
    agentStatusByPaneKey: {},
    pendingStartupByTabId: {}
  } as unknown as Parameters<typeof canFoldConversationTab>[2]
  return { item, state }
}
it('folds only confirmed exited agent tabs without changing their records', () => {
  const { item, state } = setup()
  const before = JSON.stringify(state)
  expect(canFoldConversationTab(item, null, state)).toBe(true)
  expect(JSON.stringify(state)).toBe(before)
})
it('keeps active and pinned tabs visible', () => {
  const { item, state } = setup()
  expect(canFoldConversationTab(item, 'tab', state)).toBe(false)
  item.isPinned = true
  expect(canFoldConversationTab(item, null, state)).toBe(false)
})
it.each(['records', 'foreground', 'layout', 'working', 'startup'])(
  'keeps %s uncertainty visible',
  (change) => {
    const { item, state } = setup()
    if (change === 'records') {
      state.sleepingAgentSessionsByPaneKey = {}
    }
    if (change === 'foreground') {
      state.paneForegroundAgentByPaneKey = {}
    }
    if (change === 'layout') {
      state.terminalLayoutsByTabId = {}
    }
    if (change === 'working') {
      state.agentStatusByPaneKey['tab:leaf'] = { state: 'working' } as never
    }
    if (change === 'startup') {
      state.pendingStartupByTabId.tab = { command: 'claude' } as never
    }
    expect(canFoldConversationTab(item, null, state)).toBe(false)
  }
)
it('keeps split panes visible even if one conversation ended', () => {
  const { item, state } = setup()
  state.terminalLayoutsByTabId.tab.root = { type: 'split' } as never
  expect(canFoldConversationTab(item, null, state)).toBe(false)
})
