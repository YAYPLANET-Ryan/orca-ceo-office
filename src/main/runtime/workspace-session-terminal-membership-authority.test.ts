import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { rebaseWorkspaceSessionTerminalMembership } from './workspace-session-terminal-membership-authority'

describe('legacy incarnation authority during recovery membership rebase', () => {
  it('retains a single-leaf tab incarnation when only tab.ptyId is present', () => {
    const worktreeId = 'repo::worktree'
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const leafId = '11111111-1111-4111-8111-111111111111'
    const paneKey = `tab:${leafId}`
    const prior = {
      tabsByWorktree: { [worktreeId]: [{ id: 'tab', ptyId: 'legacy-pty' }] },
      terminalLayoutsByTabId: { tab: { root: { type: 'leaf', leafId }, activeLeafId: leafId } },
      terminalTopologyRevisionByRepoId: { [repoId]: 2 },
      terminalPtyIncarnationsByPaneKey: { [paneKey]: 'original-incarnation' }
    } as unknown as WorkspaceSessionState
    const incoming = { ...prior, terminalTopologyRevisionByRepoId: { [repoId]: 1 } }
    expect(
      rebaseWorkspaceSessionTerminalMembership(incoming, prior).terminalPtyIncarnationsByPaneKey?.[
        paneKey
      ]
    ).toBe('original-incarnation')
  })
})
