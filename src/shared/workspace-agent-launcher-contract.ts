import { parseWslUncPath } from './wsl-paths'
import { buildShellCommandFromArgv, type AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './types'

export type WorkspaceContractAgent = Extract<TuiAgent, 'codex' | 'claude'>

export type WorkspaceAgentLauncherResolution = {
  workspaceRoot: string
  launcherPath: string
}

export function isWorkspaceContractAgent(agent: TuiAgent): agent is WorkspaceContractAgent {
  return agent === 'codex' || agent === 'claude'
}

export function buildWorkspaceAgentLauncherCommand(args: {
  launcherPath: string
  agent: WorkspaceContractAgent
  platform: NodeJS.Platform
  shell: AgentStartupShell
}): string {
  return buildShellCommandFromArgv(
    [launcherPathForShell(args.launcherPath, args.platform, args.shell), '--agent', args.agent],
    args.shell
  )
}

function launcherPathForShell(
  launcherPath: string,
  platform: NodeJS.Platform,
  shell: AgentStartupShell
): string {
  const wslPath = parseWslUncPath(launcherPath)?.linuxPath
  if (wslPath) {
    return wslPath
  }
  if (platform !== 'win32' && /^[A-Za-z]:[\\/]/.test(launcherPath)) {
    return nativeWindowsPathToWslPath(launcherPath)
  }
  if (platform === 'win32' && shell === 'posix') {
    return nativeWindowsPathToMsysPath(launcherPath)
  }
  return launcherPath
}

function nativeWindowsPathToWslPath(value: string): string {
  const driveMatch = value.match(/^([A-Za-z]):[\\/](.*)$/)
  return driveMatch
    ? `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2].replace(/\\/g, '/')}`
    : value.replace(/\\/g, '/')
}

function nativeWindowsPathToMsysPath(value: string): string {
  const driveMatch = value.match(/^([A-Za-z]):[\\/](.*)$/)
  return driveMatch
    ? `/${driveMatch[1].toLowerCase()}/${driveMatch[2].replace(/\\/g, '/')}`
    : value.replace(/\\/g, '/')
}
