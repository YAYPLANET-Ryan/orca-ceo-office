import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import type {
  GitStatusResult,
  GitUpstreamStatus,
  TerminalLayoutSnapshot,
  TerminalTab,
  Worktree
} from '../../../shared/types'
import {
  isCompletedAgentWorkspaceGitReady,
  planCompletedAgentWorkspaceRetirements,
  type CompletedAgentWorkspaceRetirementSnapshot
} from './completed-agent-workspace-retirement-planner'

const NOW = 40 * 60 * 1000
const IDLE_MS = 30 * 60 * 1000
const WORKTREE_ID = 'repo::/worktrees/task-codex'
const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = `${TAB_ID}:${LEAF_ID}`

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: WORKTREE_ID,
    repoId: 'repo',
    displayName: 'task-codex',
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
    createdWithAgent: 'codex',
    path: '/worktrees/task-codex',
    head: 'abc123',
    branch: 'task-codex',
    isBare: false,
    isMainWorktree: false,
    ...overrides
  }
}

function tab(overrides: Partial<TerminalTab> = {}): TerminalTab {
  return {
    id: TAB_ID,
    ptyId: 'pty-1',
    worktreeId: WORKTREE_ID,
    title: 'Codex',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1,
    launchAgent: 'codex',
    ...overrides
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

function entry(overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'finish and push',
    updatedAt: NOW - IDLE_MS - 1,
    stateStartedAt: NOW - IDLE_MS - 1,
    paneKey: PANE_KEY,
    tabId: TAB_ID,
    worktreeId: WORKTREE_ID,
    agentType: 'codex',
    providerSession: { key: 'session_id', id: 'codex-session-1' },
    stateHistory: [{ state: 'working', prompt: 'finish and push', startedAt: 1 }],
    ...overrides
  }
}

function snapshot(
  overrides: Partial<CompletedAgentWorkspaceRetirementSnapshot> = {}
): CompletedAgentWorkspaceRetirementSnapshot {
  const status = entry()
  return {
    settings: {
      autoArchiveCompletedAgentWorkspaces: true,
      agentHibernationIdleMs: IDLE_MS
    },
    worktrees: [worktree()],
    activeWorktreeId: 'repo::/main',
    foregroundTerminalTabIds: [],
    tabsByWorktree: { [WORKTREE_ID]: [tab()] },
    terminalLayoutsByTabId: { [TAB_ID]: layout() },
    ptyIdsByTabId: { [TAB_ID]: ['pty-1'] },
    runtimeLivePtyIdsByWorktreeId: {},
    runtimeLivenessRequiredWorktreeIds: [],
    mobileLockedPtyIds: [],
    agentStatusByPaneKey: { [PANE_KEY]: status },
    lastTerminalInputAtByPaneKey: {},
    foregroundTerminalLastSeenAtByTabId: {},
    openFileCountByWorktreeId: {},
    browserTabCountByWorktreeId: {},
    now: NOW,
    ...overrides
  }
}

describe('completed agent workspace retirement planner', () => {
  it.each([
    ['Codex', 'codex' as const, 'session_id' as const],
    ['Claude', 'claude' as const, 'session_id' as const]
  ])(
    'retires an idle background %s workspace only after all live panes completed',
    (_, agent, key) => {
      const status = entry({ agentType: agent, providerSession: { key, id: `${agent}-session` } })
      const result = planCompletedAgentWorkspaceRetirements(
        snapshot({
          worktrees: [worktree({ createdWithAgent: agent })],
          tabsByWorktree: { [WORKTREE_ID]: [tab({ launchAgent: agent })] },
          agentStatusByPaneKey: { [PANE_KEY]: status }
        })
      )

      expect(result).toEqual([
        expect.objectContaining({
          id: WORKTREE_ID,
          worktreeId: WORKTREE_ID,
          paneKeys: [PANE_KEY],
          targetPtyIds: ['pty-1'],
          expectedRuntimePtyIds: [],
          expectedHead: 'abc123'
        })
      ])
    }
  )

  it.each([
    ['main worktree', { worktrees: [worktree({ isMainWorktree: true })] }],
    [
      'ambiguous duplicate workspace identity',
      { worktrees: [worktree(), worktree({ hostId: 'runtime:other' })] }
    ],
    ['active worktree', { activeWorktreeId: WORKTREE_ID }],
    ['manually discovered worktree', { worktrees: [worktree({ createdAt: undefined })] }],
    ['pinned worktree', { worktrees: [worktree({ isPinned: true })] }],
    ['open editor', { openFileCountByWorktreeId: { [WORKTREE_ID]: 1 } }],
    ['open browser', { browserTabCountByWorktreeId: { [WORKTREE_ID]: 1 } }],
    ['foreground tab', { foregroundTerminalTabIds: [TAB_ID] }]
  ])('fails closed for a %s', (_, overrides) => {
    expect(
      planCompletedAgentWorkspaceRetirements(
        snapshot(overrides as Partial<CompletedAgentWorkspaceRetirementSnapshot>)
      )
    ).toEqual([])
  })

  it.each([
    ['a draft typed after completion', { lastTerminalInputAtByPaneKey: { [PANE_KEY]: NOW } }],
    ['a recently viewed terminal', { foregroundTerminalLastSeenAtByTabId: { [TAB_ID]: NOW } }]
  ])('preserves the workspace when it has %s', (_, overrides) => {
    expect(
      planCompletedAgentWorkspaceRetirements(
        snapshot(overrides as Partial<CompletedAgentWorkspaceRetirementSnapshot>)
      )
    ).toEqual([])
  })

  it.each([
    ['still working', { state: 'working' as const }],
    ['interrupted', { interrupted: true }],
    ['live subagent', { subagents: [{ id: 'child', state: 'working' as const, startedAt: 1 }] }],
    ['too recent', { updatedAt: NOW - IDLE_MS + 1 }],
    ['unsupported provider', { agentType: 'gemini' }],
    ['missing resume identity', { providerSession: undefined }]
  ])('does not retire when an agent pane is %s', (_, statusOverrides) => {
    const status = entry(statusOverrides)
    expect(
      planCompletedAgentWorkspaceRetirements(
        snapshot({ agentStatusByPaneKey: { [PANE_KEY]: status } })
      )
    ).toEqual([])
  })

  it('requires authoritative remote PTY liveness and preserves exact stop handles', () => {
    expect(
      planCompletedAgentWorkspaceRetirements(
        snapshot({ runtimeLivenessRequiredWorktreeIds: [WORKTREE_ID] })
      )
    ).toEqual([])

    const [candidate] = planCompletedAgentWorkspaceRetirements(
      snapshot({
        runtimeLivenessRequiredWorktreeIds: [WORKTREE_ID],
        runtimeLivePtyIdsByWorktreeId: { [WORKTREE_ID]: ['pty-1'] }
      })
    )
    expect(candidate?.expectedRuntimePtyIds).toEqual(['pty-1'])
  })

  it('recognizes a workspace created by Codex or Claude through the Orca CLI', () => {
    const [candidate] = planCompletedAgentWorkspaceRetirements(
      snapshot({
        worktrees: [
          worktree({
            createdWithAgent: undefined,
            cliProvenance: {
              kind: 'created-by-cli',
              createdAt: 1,
              callerTerminalHandle: 'parent-agent-terminal'
            }
          })
        ],
        tabsByWorktree: { [WORKTREE_ID]: [tab({ launchAgent: undefined })] }
      })
    )
    expect(candidate?.worktreeId).toBe(WORKTREE_ID)
  })

  it.each([
    ['Codex', 'codex' as const, 'session_id' as const],
    ['Claude', 'claude' as const, 'session_id' as const]
  ])('selects a dormant %s workspace after its PTY has already exited', (_, agent, key) => {
    const status = entry({
      agentType: agent,
      providerSession: { key, id: `${agent}-dormant-session` }
    })
    const [candidate] = planCompletedAgentWorkspaceRetirements(
      snapshot({
        worktrees: [worktree({ createdWithAgent: agent })],
        tabsByWorktree: { [WORKTREE_ID]: [tab({ launchAgent: agent, ptyId: null })] },
        terminalLayoutsByTabId: {
          [TAB_ID]: { ...layout(), ptyIdsByLeafId: {} }
        },
        ptyIdsByTabId: { [TAB_ID]: [] },
        agentStatusByPaneKey: { [PANE_KEY]: status }
      })
    )

    expect(candidate).toMatchObject({
      worktreeId: WORKTREE_ID,
      mode: 'dormant-workspace',
      paneKeys: [],
      targetPtyIds: [],
      expectedRuntimePtyIds: []
    })
  })

  it('selects an old agent-created workspace even when its terminal tab is already gone', () => {
    const [candidate] = planCompletedAgentWorkspaceRetirements(
      snapshot({
        tabsByWorktree: { [WORKTREE_ID]: [] },
        terminalLayoutsByTabId: {},
        ptyIdsByTabId: {},
        agentStatusByPaneKey: {}
      })
    )
    expect(candidate?.mode).toBe('dormant-workspace')
  })

  it.each([
    ['recent activity', { worktrees: [worktree({ lastActivityAt: NOW - IDLE_MS + 1 })] }],
    [
      'unknown agent provenance',
      {
        worktrees: [worktree({ createdWithAgent: undefined })],
        tabsByWorktree: { [WORKTREE_ID]: [tab({ launchAgent: undefined, ptyId: null })] }
      }
    ],
    [
      'unknown remote liveness',
      {
        runtimeLivenessRequiredWorktreeIds: [WORKTREE_ID],
        runtimeLivePtyIdsByWorktreeId: {}
      }
    ]
  ])('keeps a dormant workspace with %s', (_, overrides) => {
    expect(
      planCompletedAgentWorkspaceRetirements(
        snapshot({
          tabsByWorktree: { [WORKTREE_ID]: [tab({ ptyId: null })] },
          terminalLayoutsByTabId: {
            [TAB_ID]: { ...layout(), ptyIdsByLeafId: {} }
          },
          ptyIdsByTabId: { [TAB_ID]: [] },
          ...overrides
        } as Partial<CompletedAgentWorkspaceRetirementSnapshot>)
      )
    ).toEqual([])
  })
})

describe('completed agent workspace git readiness', () => {
  it('accepts only a complete clean status with a fetched in-sync upstream', () => {
    expect(
      isCompletedAgentWorkspaceGitReady(
        { entries: [], conflictOperation: 'unknown', head: 'abc123', didHitLimit: false },
        { hasUpstream: true, ahead: 0, behind: 0 },
        'abc123'
      )
    ).toBe(true)
  })

  it.each([
    [
      'dirty files',
      {
        entries: [{ path: 'x', status: 'modified', area: 'unstaged' }],
        conflictOperation: 'unknown'
      },
      { hasUpstream: true, ahead: 0, behind: 0 }
    ],
    [
      'truncated status',
      { entries: [], conflictOperation: 'unknown', didHitLimit: true },
      { hasUpstream: true, ahead: 0, behind: 0 }
    ],
    [
      'no upstream',
      { entries: [], conflictOperation: 'unknown' },
      { hasUpstream: false, ahead: 0, behind: 0 }
    ],
    [
      'unpushed commit',
      { entries: [], conflictOperation: 'unknown' },
      { hasUpstream: true, ahead: 1, behind: 0 }
    ],
    [
      'head changed',
      { entries: [], conflictOperation: 'unknown', head: 'new-head' },
      { hasUpstream: true, ahead: 0, behind: 0 }
    ]
  ])('rejects %s', (_, status, upstream) => {
    expect(
      isCompletedAgentWorkspaceGitReady(
        status as GitStatusResult,
        upstream as GitUpstreamStatus,
        'abc123'
      )
    ).toBe(false)
  })
})
