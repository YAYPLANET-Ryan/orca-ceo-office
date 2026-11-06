import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/setup-agent-sequencing'
import { applyAgentLaunchArgsToCustomCommand } from '../../../../shared/tui-agent-launch-command'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../../shared/windows-terminal-shell'

const NATIVE_WINDOWS_HOST = { platform: 'win32' as const, isRemote: false }

/** The shell grammar a native Windows local spawn's user-authored command is
 * parsed with (quick commands, CLI --command, pasted resume lines), or null
 * when the launch contract does not apply (ORCA's own TUI launches carry it
 * already; remote, WSL and non-Windows spawns never get it). */
export function resolveCustomCommandContractShell(args: {
  applies: boolean
  terminalWindowsShell: string | null | undefined
}): AgentStartupShell | null {
  if (!args.applies) {
    return null
  }
  return (
    resolveLocalWindowsAgentStartupShell({
      ...NATIVE_WINDOWS_HOST,
      terminalWindowsShell: args.terminalWindowsShell ?? null
    }) ?? 'powershell'
  )
}

export function applyCustomCommandContract(
  command: string | undefined,
  shell: AgentStartupShell | null
): string | undefined {
  return command && shell
    ? applyAgentLaunchArgsToCustomCommand(command, shell, NATIVE_WINDOWS_HOST)
    : command
}

/** Why: buildPtyHostEnv prefers the sequenced startup command over the launch
 * command, and the gate evaluates it with bash `eval` for a POSIX pane and
 * PowerShell `Invoke-Expression` for every other native Windows pane
 * (setup-agent-sequencing.ts), so the contract is quoted for that grammar. */
export function applyCustomCommandContractToSequencedStartup<
  T extends Record<string, string> | undefined
>(env: T, shell: AgentStartupShell | null): T {
  const sequenced = env?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]
  if (!sequenced || !shell) {
    return env
  }
  return {
    ...env,
    [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: applyAgentLaunchArgsToCustomCommand(
      sequenced,
      shell === 'posix' ? 'posix' : 'powershell',
      NATIVE_WINDOWS_HOST
    )
  } as T
}
