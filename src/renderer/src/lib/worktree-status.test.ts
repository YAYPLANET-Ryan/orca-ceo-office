import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  selectWorktreeAgentActivitySummary,
  type AgentActivityInput
} from '@/components/sidebar/workspace-card/activity/worktree-agent-activity-summary'
import type { TerminalLayoutSnapshot } from '../../../shared/workspace-layout/terminal-tab-types'
import { resolveWorktreeStatus } from './worktree-status'

const LEAF_ID_1 = '11111111-1111-4111-8111-111111111111'
const LEAF_ID_2 = '22222222-2222-4222-8222-222222222222'

// Tests declare live tab IDs; tab.ptyId survives sleep as a wake hint and must not imply liveness.
function livePtyMap(...tabIds: string[]): Record<string, string[]> {
  return Object.fromEntries(tabIds.map((id, i) => [id, [`pty-${i}`]]))
}

function splitLayout(): TerminalLayoutSnapshot {
  return {
    root: {
      type: 'split',
      direction: 'vertical',
      first: { type: 'leaf', leafId: LEAF_ID_1 },
      second: { type: 'leaf', leafId: LEAF_ID_2 }
    },
    activeLeafId: LEAF_ID_1,
    expandedLeafId: null
  }
}

describe('resolveWorktreeStatus', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each([
    { provider: 'claude', paneTitle: false },
    { provider: 'claude', paneTitle: true },
    { provider: 'codex', paneTitle: false },
    { provider: 'codex', paneTitle: true }
  ] as const)(
    'does not revive $provider working after done expires (pane title: $paneTitle)',
    ({ provider, paneTitle }) => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
      const tab = { id: 'tab-1', title: `${provider} [working]`, launchAgent: provider }
      const paneKey = `tab-1:${LEAF_ID_1}`
      const entry = {
        paneKey,
        state: 'done' as const,
        agentType: provider,
        prompt: '',
        updatedAt: 1000,
        stateStartedAt: 1000,
        stateHistory: [],
        worktreeId: 'worktree-1'
      }
      const state: AgentActivityInput = {
        tabsByWorktree: { 'worktree-1': [tab] },
        agentStatusByPaneKey: { [paneKey]: entry },
        agentStatusEpoch: 0,
        migrationUnsupportedByPtyId: {},
        retainedAgentsByPaneKey: {}
      }
      const status = () =>
        resolveWorktreeStatus({
          ...selectWorktreeAgentActivitySummary(state, 'worktree-1'),
          tabs: [tab],
          browserTabs: [],
          ptyIdsByTabId: livePtyMap(tab.id),
          runtimePaneTitlesByTabId: paneTitle ? { [tab.id]: { 1: tab.title } } : {},
          terminalLayoutsByTabId: { [tab.id]: splitLayout() }
        })
      expect(status()).toBe('done')
      clock.mockReturnValue(1000 + 30 * 60 * 1000 + 1)
      state.agentStatusEpoch++
      expect(status()).toBe('active')
      state.agentStatusByPaneKey = {
        [paneKey]: { ...entry, state: 'working', updatedAt: Date.now(), stateStartedAt: Date.now() }
      }
      expect(status()).toBe('working')
    }
  )

  it('requires a fresh event to claim work when an earlier working row expires', () => {
    const options = {
      tabs: [{ id: 'tab-1', title: 'claude [working]' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      stalePaneIdsByTabId: { 'tab-1': new Set([LEAF_ID_1]) },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: false,
      hasRetainedDone: false
    }
    expect(resolveWorktreeStatus(options)).toBe('active')
    expect(resolveWorktreeStatus({ ...options, hasLiveWorking: true })).toBe('working')
    expect(
      resolveWorktreeStatus({ ...options, tabs: [{ id: 'tab-1', title: 'claude [permission]' }] })
    ).toBe('permission')
    expect(resolveWorktreeStatus({ ...options, stalePaneIdsByTabId: {} })).toBe('working')
  })

  it('lets a hook-covered done pane suppress its stale working title', () => {
    const status = resolveWorktreeStatus({
      tabs: [{ id: 'tab-1', title: 'claude [working]' }],
      browserTabs: [],
      ptyIdsByTabId: livePtyMap('tab-1'),
      runtimePaneTitlesByTabId: {
        'tab-1': {
          1: 'codex [working]',
          2: 'bash'
        }
      },
      agentStatusPaneIdsByTabId: {
        'tab-1': new Set([LEAF_ID_1])
      },
      terminalLayoutsByTabId: {
        'tab-1': splitLayout()
      },
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveDone: true,
      hasRetainedDone: false
    })

    expect(status).toBe('done')
  })

  it.each([false, true])(
    'keeps a sibling working when another pane has an expired status: %s',
    (stale) => {
      const status = resolveWorktreeStatus({
        tabs: [{ id: 'tab-1', title: 'claude [working]' }],
        browserTabs: [],
        ptyIdsByTabId: livePtyMap('tab-1'),
        runtimePaneTitlesByTabId: {
          'tab-1': {
            1: 'bash',
            2: 'codex [working]'
          }
        },
        agentStatusPaneIdsByTabId: stale ? {} : { 'tab-1': new Set([LEAF_ID_1]) },
        stalePaneIdsByTabId: stale ? { 'tab-1': new Set([LEAF_ID_1]) } : {},
        terminalLayoutsByTabId: {
          'tab-1': splitLayout()
        },
        hasPermission: false,
        hasLiveWorking: false,
        hasLiveDone: !stale,
        hasRetainedDone: false
      })

      expect(status).toBe('working')
    }
  )
})
