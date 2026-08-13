import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type { TerminalLayoutSnapshot, TerminalTab, Worktree } from '../../../shared/types'
import { useAppStore } from '@/store'
import {
  resetCompletedAgentWorkspaceRetirementCoordinatorForTests,
  runCompletedAgentWorkspaceRetirementTick
} from './completed-agent-workspace-retirement-coordinator'
import { resetForegroundTerminalTabIdsForTests } from './foreground-terminal-tabs'
import { resetAgentHibernationOutputActivityForTests } from './agent-hibernation-output-activity'
import { hydrateDrivers } from './pane-manager/mobile-driver-state'
import type { AppState } from '@/store/types'

const NOW = 40 * 60 * 1000
const IDLE_MS = 30 * 60 * 1000
const WORKTREE_ID = 'repo::/worktrees/task-claude'
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`

const gitStatus = vi.fn()
const gitFetch = vi.fn()
const gitUpstreamStatus = vi.fn()
const hasKillableLocalProcesses = vi.fn()

vi.stubGlobal('window', {
  api: {
    git: {
      status: gitStatus,
      fetch: gitFetch,
      upstreamStatus: gitUpstreamStatus
    },
    workspaceCleanup: {
      hasKillableLocalProcesses
    }
  }
})

function worktree(): Worktree {
  return {
    id: WORKTREE_ID,
    repoId: 'repo',
    hostId: 'local',
    displayName: 'task-claude',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    createdWithAgent: 'claude',
    path: '/worktrees/task-claude',
    head: 'abc123',
    branch: 'task-claude',
    isBare: false,
    isMainWorktree: false
  }
}

function tab(): TerminalTab {
  return {
    id: TAB_ID,
    ptyId: 'pty-1',
    worktreeId: WORKTREE_ID,
    title: 'Claude',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    launchAgent: 'claude'
  }
}

function layout(): TerminalLayoutSnapshot {
  return {
    root: { type: 'leaf', leafId: LEAF_ID },
    activeLeafId: LEAF_ID,
    expandedLeafId: null,
    ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
  }
}

function entry(): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'finish and push',
    updatedAt: NOW - IDLE_MS - 1,
    stateStartedAt: NOW - IDLE_MS - 1,
    paneKey: PANE_KEY,
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID,
    agentType: 'claude',
    providerSession: { key: 'session_id', id: 'claude-session-1' },
    stateHistory: [{ state: 'working', prompt: 'finish and push', startedAt: 1 }]
  }
}

function installState(): {
  shutdown: ReturnType<typeof vi.fn>
  updateMeta: ReturnType<typeof vi.fn>
} {
  const shutdown = vi.fn().mockResolvedValue(undefined)
  const updateMeta = vi.fn().mockResolvedValue({ ok: true })
  const status = entry()
  useAppStore.setState({
    settings: {
      autoArchiveCompletedAgentWorkspaces: true,
      agentHibernationIdleMs: IDLE_MS,
      activeRuntimeEnvironmentId: null
    } as never,
    activeWorktreeId: 'repo::/main',
    repos: [{ id: 'repo', name: 'repo', path: '/repo', connectionId: null }] as never,
    worktreesByRepo: { repo: [worktree()] },
    detectedWorktreesByRepo: {},
    tabsByWorktree: { [WORKTREE_ID]: [tab()] },
    terminalLayoutsByTabId: { [TAB_ID]: layout() },
    ptyIdsByTabId: { [TAB_ID]: ['pty-1'] },
    agentStatusByPaneKey: { [PANE_KEY]: status },
    openFiles: [],
    browserTabsByWorktree: {},
    shutdownWorktreeTerminals: shutdown as never,
    updateWorktreeMeta: updateMeta as never
  } as Partial<AppState>)
  return { shutdown, updateMeta }
}

afterEach(() => {
  resetCompletedAgentWorkspaceRetirementCoordinatorForTests()
  resetForegroundTerminalTabIdsForTests()
  resetAgentHibernationOutputActivityForTests()
  hydrateDrivers([])
  gitStatus.mockReset()
  gitFetch.mockReset()
  gitUpstreamStatus.mockReset()
  hasKillableLocalProcesses.mockReset()
})

describe('completed agent workspace retirement coordinator', () => {
  it('marks completed, sleeps resumable sessions, and archives after two safe stable ticks', async () => {
    const { shutdown, updateMeta } = installState()
    gitStatus.mockResolvedValue({
      entries: [],
      conflictOperation: 'unknown',
      head: 'abc123',
      branch: 'task-claude'
    })
    gitFetch.mockResolvedValue(undefined)
    gitUpstreamStatus.mockResolvedValue({ hasUpstream: true, ahead: 0, behind: 0 })

    await runCompletedAgentWorkspaceRetirementTick({ now: () => NOW })
    expect(shutdown).not.toHaveBeenCalled()

    await runCompletedAgentWorkspaceRetirementTick({ now: () => NOW })

    expect(gitFetch).toHaveBeenCalledWith({
      worktreePath: '/worktrees/task-claude',
      connectionId: undefined
    })
    expect(shutdown).toHaveBeenCalledWith(WORKTREE_ID, {
      keepIdentifiers: true,
      shutdownReason: 'auto-hibernate-completed-agent',
      sleepingPaneKeys: [PANE_KEY]
    })
    expect(updateMeta).toHaveBeenNthCalledWith(1, WORKTREE_ID, {
      workspaceStatus: 'completed'
    })
    expect(updateMeta).toHaveBeenNthCalledWith(2, WORKTREE_ID, {
      workspaceStatus: 'completed',
      isArchived: true,
      isUnread: false
    })
  })

  it.each([
    [
      'dirty files',
      {
        entries: [{ path: 'x', status: 'modified', area: 'unstaged' }],
        conflictOperation: 'unknown',
        head: 'abc123'
      },
      { hasUpstream: true, ahead: 0, behind: 0 }
    ],
    [
      'missing upstream',
      { entries: [], conflictOperation: 'unknown', head: 'abc123' },
      { hasUpstream: false, ahead: 0, behind: 0 }
    ],
    [
      'unpushed commit',
      { entries: [], conflictOperation: 'unknown', head: 'abc123' },
      { hasUpstream: true, ahead: 1, behind: 0 }
    ]
  ])('does not stop or archive with %s', async (_, status, upstream) => {
    const { shutdown, updateMeta } = installState()
    gitStatus.mockResolvedValue(status)
    gitFetch.mockResolvedValue(undefined)
    gitUpstreamStatus.mockResolvedValue(upstream)

    await runCompletedAgentWorkspaceRetirementTick({ now: () => NOW })
    await runCompletedAgentWorkspaceRetirementTick({ now: () => NOW })

    expect(shutdown).not.toHaveBeenCalled()
    expect(updateMeta).not.toHaveBeenCalled()
  })

  it('rechecks Git immediately before shutdown so a late commit cannot be archived', async () => {
    const { shutdown, updateMeta } = installState()
    gitStatus
      .mockResolvedValueOnce({
        entries: [],
        conflictOperation: 'unknown',
        head: 'abc123'
      })
      .mockResolvedValueOnce({
        entries: [],
        conflictOperation: 'unknown',
        head: 'late-local-commit'
      })
    gitFetch.mockResolvedValue(undefined)
    gitUpstreamStatus.mockResolvedValue({ hasUpstream: true, ahead: 0, behind: 0 })

    await runCompletedAgentWorkspaceRetirementTick({ now: () => NOW })
    await runCompletedAgentWorkspaceRetirementTick({ now: () => NOW })

    expect(gitStatus).toHaveBeenCalledTimes(2)
    expect(shutdown).not.toHaveBeenCalled()
    expect(updateMeta).not.toHaveBeenCalled()
  })

  it('cancels a failed archive retry when the user reopens the workspace', async () => {
    const { updateMeta } = installState()
    updateMeta.mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce({
      ok: false,
      error: 'temporary metadata failure'
    })
    gitStatus.mockResolvedValue({
      entries: [],
      conflictOperation: 'unknown',
      head: 'abc123'
    })
    gitFetch.mockResolvedValue(undefined)
    gitUpstreamStatus.mockResolvedValue({ hasUpstream: true, ahead: 0, behind: 0 })

    await runCompletedAgentWorkspaceRetirementTick({ now: () => NOW })
    await runCompletedAgentWorkspaceRetirementTick({ now: () => NOW })
    expect(updateMeta).toHaveBeenCalledTimes(2)

    useAppStore.setState({ activeWorktreeId: WORKTREE_ID })
    await runCompletedAgentWorkspaceRetirementTick({ now: () => NOW })
    expect(updateMeta).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['Codex', 'codex' as const],
    ['Claude', 'claude' as const]
  ])('archives a dormant %s workspace without destroying its saved tab', async (_, agent) => {
    const { shutdown, updateMeta } = installState()
    useAppStore.setState((state) => ({
      worktreesByRepo: {
        repo: [{ ...state.worktreesByRepo.repo[0]!, createdWithAgent: agent }]
      },
      tabsByWorktree: {
        [WORKTREE_ID]: [
          { ...state.tabsByWorktree[WORKTREE_ID]![0]!, ptyId: null, launchAgent: agent }
        ]
      },
      terminalLayoutsByTabId: {
        [TAB_ID]: { ...layout(), ptyIdsByLeafId: {} }
      },
      ptyIdsByTabId: { [TAB_ID]: [] }
    }))
    hasKillableLocalProcesses.mockResolvedValue({ hasKillableProcesses: false })
    gitStatus.mockResolvedValue({
      entries: [],
      conflictOperation: 'unknown',
      head: 'abc123'
    })
    gitFetch.mockResolvedValue(undefined)
    gitUpstreamStatus.mockResolvedValue({ hasUpstream: true, ahead: 0, behind: 0 })

    await runCompletedAgentWorkspaceRetirementTick({ now: () => NOW })
    await runCompletedAgentWorkspaceRetirementTick({ now: () => NOW })

    expect(hasKillableLocalProcesses).toHaveBeenCalledWith({
      worktreeId: WORKTREE_ID,
      connectionId: null,
      worktreePath: '/worktrees/task-claude'
    })
    expect(shutdown).not.toHaveBeenCalled()
    expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID]).toHaveLength(1)
    expect(updateMeta).toHaveBeenCalledWith(WORKTREE_ID, {
      workspaceStatus: 'completed',
      isArchived: true,
      isUnread: false
    })
  })

  it.each([true, null])(
    'keeps a dormant workspace when process liveness is %s',
    async (hasProcesses) => {
      const { shutdown, updateMeta } = installState()
      useAppStore.setState({
        terminalLayoutsByTabId: {
          [TAB_ID]: { ...layout(), ptyIdsByLeafId: {} }
        },
        ptyIdsByTabId: { [TAB_ID]: [] }
      })
      hasKillableLocalProcesses.mockResolvedValue({ hasKillableProcesses: hasProcesses })

      await runCompletedAgentWorkspaceRetirementTick({ now: () => NOW })
      await runCompletedAgentWorkspaceRetirementTick({ now: () => NOW })

      expect(shutdown).not.toHaveBeenCalled()
      expect(updateMeta).not.toHaveBeenCalled()
    }
  )
})
