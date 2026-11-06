import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { OrcaRuntimeService } from './orca-runtime'

const worktreeId = 'repo::/tmp/sleep-project'
const leafId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const paneKey = `tab:${leafId}`

describe('worktree sleep preserves session membership', () => {
  it.each([0, -1])('retains the tab and resume record after provider exit %s', async (exitCode) => {
    let session = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: {
        [worktreeId]: [
          {
            id: 'tab',
            worktreeId,
            ptyId: 'pty-sleep',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab: {
          root: { type: 'leaf' as const, leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: { [leafId]: 'pty-sleep' }
        }
      },
      sleepingAgentSessionsByPaneKey: {
        [paneKey]: {
          agent: 'codex' as const,
          providerSession: { key: 'session_id' as const, id: 'original' },
          source: 'live' as const,
          updatedAt: 1
        }
      }
    }
    const repo = {
      id: 'repo',
      path: '/tmp/sleep-project',
      displayName: 'repo',
      badgeColor: 'blue',
      addedAt: 1,
      kind: 'folder'
    }
    const runtime = new OrcaRuntimeService({
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({ [worktreeId]: { hostId: 'local' } }),
      getWorktreeMeta: () => ({ hostId: 'local' }),
      setWorktreeMeta: (_id: string, patch: object) => ({ hostId: 'local', ...patch }),
      getWorkspaceSession: () => session,
      setWorkspaceSession: (next: typeof session) => {
        session = next
      },
      flushOrThrow: () => {}
    } as never)
    runtime.registerPty('pty-sleep', worktreeId, null, {
      tabId: 'tab',
      leafId,
      incarnationId: 'inc-sleep'
    })
    let live = true
    runtime.setPtyController({
      write: () => true,
      kill: () => false,
      getForegroundProcess: async () => null,
      listProcesses: async () =>
        live ? [{ id: 'pty-sleep', cwd: repo.path, worktreeId, title: 'Terminal' }] : [],
      stopAndWait: async (ptyId) => {
        runtime.onPtyExit(ptyId, exitCode, 'inc-sleep')
        live = false
        return true
      }
    })
    expect(await runtime.sleepTerminalsForWorktree(`id:${worktreeId}`)).toMatchObject({
      stopped: 1,
      postStopVerified: true
    })
    expect(session.tabsByWorktree[worktreeId]).toHaveLength(1)
    expect(session.terminalLayoutsByTabId.tab.root).toEqual({ type: 'leaf', leafId })
    expect(session.sleepingAgentSessionsByPaneKey[paneKey].providerSession.id).toBe('original')
    expect((await runtime.listMobileSessionTabs(`id:${worktreeId}`)).tabs).toHaveLength(1)

    runtime.onPtyExit('pty-sleep', 0, 'inc-sleep', { providerExitObserved: true })
    expect(session.tabsByWorktree[worktreeId]).toHaveLength(1)

    // A later incarnation's ordinary exit must still retire its surface.
    const release = await runtime.acquireWorktreeTerminalSpawn(worktreeId)
    release()
    runtime.registerPty('pty-sleep', worktreeId, null, {
      tabId: 'tab',
      leafId,
      incarnationId: 'inc-awake'
    })
    runtime.onPtyExit('pty-sleep', 0, 'inc-awake')
    expect(session.tabsByWorktree[worktreeId] ?? []).toHaveLength(0)
  })
})
