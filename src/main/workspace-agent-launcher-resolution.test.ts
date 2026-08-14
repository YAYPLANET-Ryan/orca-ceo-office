import { describe, expect, it, vi } from 'vitest'

import { resolveWorkspaceAgentLauncher } from './workspace-agent-launcher-resolution'

function makeStat(entries: Record<string, 'file' | 'directory'>) {
  return vi.fn(async (candidate: string) => entries[candidate.replaceAll('\\', '/')] ?? null)
}

describe('resolveWorkspaceAgentLauncher', () => {
  it('finds the Windows launcher at the nearest owning Git root', async () => {
    const statPath = makeStat({
      'C:/CEO Office/.git': 'directory',
      'C:/CEO Office/scripts/Start-OrcaAgent.cmd': 'file'
    })

    await expect(
      resolveWorkspaceAgentLauncher({
        workspacePath: 'C:\\CEO Office\\Businesses\\OilDealer',
        platform: 'win32',
        statPath
      })
    ).resolves.toEqual({
      workspaceRoot: 'C:\\CEO Office',
      launcherPath: 'C:\\CEO Office\\scripts\\Start-OrcaAgent.cmd'
    })
  })

  it('finds the POSIX launcher for a Git worktree root', async () => {
    const statPath = makeStat({
      '/srv/worktrees/oildealer/.git': 'file',
      '/srv/worktrees/oildealer/scripts/start-orca-agent': 'file'
    })

    await expect(
      resolveWorkspaceAgentLauncher({
        workspacePath: '/srv/worktrees/oildealer',
        platform: 'linux',
        statPath
      })
    ).resolves.toEqual({
      workspaceRoot: '/srv/worktrees/oildealer',
      launcherPath: '/srv/worktrees/oildealer/scripts/start-orca-agent'
    })
  })

  it('does not escape a nested Git root when its launcher is absent', async () => {
    const statPath = makeStat({
      '/srv/mono/.git': 'directory',
      '/srv/mono/scripts/start-orca-agent': 'file',
      '/srv/mono/vendor/project/.git': 'directory'
    })

    await expect(
      resolveWorkspaceAgentLauncher({
        workspacePath: '/srv/mono/vendor/project/src',
        platform: 'linux',
        statPath
      })
    ).resolves.toBeNull()
    expect(statPath).not.toHaveBeenCalledWith('/srv/mono/.git')
  })

  it('returns null when no owning Git root exists', async () => {
    await expect(
      resolveWorkspaceAgentLauncher({
        workspacePath: '/srv/folder-only',
        platform: 'linux',
        statPath: makeStat({})
      })
    ).resolves.toBeNull()
  })
})
