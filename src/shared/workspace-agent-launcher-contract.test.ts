import { describe, expect, it } from 'vitest'

import { buildWorkspaceAgentLauncherCommand } from './workspace-agent-launcher-contract'

describe('buildWorkspaceAgentLauncherCommand', () => {
  it('quotes a Windows path with spaces for PowerShell', () => {
    expect(
      buildWorkspaceAgentLauncherCommand({
        launcherPath: 'C:\\CEO Office\\scripts\\Start-OrcaAgent.cmd',
        agent: 'codex',
        platform: 'win32',
        shell: 'powershell'
      })
    ).toBe("& 'C:\\CEO Office\\scripts\\Start-OrcaAgent.cmd' '--agent' 'codex'")
  })

  it('uses an MSYS path when a Windows workspace launches from Git Bash', () => {
    expect(
      buildWorkspaceAgentLauncherCommand({
        launcherPath: 'C:\\CEO Office\\scripts\\Start-OrcaAgent.cmd',
        agent: 'claude',
        platform: 'win32',
        shell: 'posix'
      })
    ).toBe("'/c/CEO Office/scripts/Start-OrcaAgent.cmd' '--agent' 'claude'")
  })

  it('uses the Linux path for a WSL-owned launch', () => {
    expect(
      buildWorkspaceAgentLauncherCommand({
        launcherPath:
          '\\\\wsl.localhost\\Ubuntu\\home\\ryan\\CEO Office\\scripts\\start-orca-agent',
        agent: 'codex',
        platform: 'linux',
        shell: 'posix'
      })
    ).toBe("'/home/ryan/CEO Office/scripts/start-orca-agent' '--agent' 'codex'")
  })

  it('maps a Windows checkout into WSL when Linux owns the launch', () => {
    expect(
      buildWorkspaceAgentLauncherCommand({
        launcherPath: 'D:\\CEO Office\\scripts\\start-orca-agent',
        agent: 'claude',
        platform: 'linux',
        shell: 'posix'
      })
    ).toBe("'/mnt/d/CEO Office/scripts/start-orca-agent' '--agent' 'claude'")
  })
})
