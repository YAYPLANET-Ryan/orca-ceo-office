import path from 'node:path'

import { isWindowsAbsolutePathLike } from '../shared/cross-platform-path'
import type { WorkspaceAgentLauncherResolution } from '../shared/workspace-agent-launcher-contract'

type WorkspacePathEntryKind = 'file' | 'directory' | 'other' | null

export async function resolveWorkspaceAgentLauncher(args: {
  workspacePath: string
  platform: NodeJS.Platform
  statPath: (candidate: string) => Promise<WorkspacePathEntryKind>
}): Promise<WorkspaceAgentLauncherResolution | null> {
  const workspacePath = args.workspacePath.trim()
  if (!workspacePath) {
    return null
  }

  const pathImpl = isWindowsAbsolutePathLike(workspacePath) ? path.win32 : path.posix
  const launcherRelativePath =
    args.platform === 'win32' ? ['scripts', 'Start-OrcaAgent.cmd'] : ['scripts', 'start-orca-agent']
  let current = pathImpl.resolve(workspacePath)

  while (true) {
    const gitMarker = pathImpl.join(current, '.git')
    if ((await args.statPath(gitMarker)) !== null) {
      const launcherPath = pathImpl.join(current, ...launcherRelativePath)
      return (await args.statPath(launcherPath)) === 'file'
        ? { workspaceRoot: current, launcherPath }
        : null
    }

    const parent = pathImpl.dirname(current)
    if (parent === current) {
      return null
    }
    current = parent
  }
}
