import { TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  findStartupCommandExecutableIndex,
  isPosixStartupShell,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

/**
 * Where, in a tokenized startup command, the agent executable actually runs on
 * this host. Shared by the launch contract (tui-agent-launch-command.ts) for
 * ORCA's own launches and for user-authored commands.
 */
const REMOTING_WRAPPERS = new Set(['wsl', 'ssh', 'docker', 'kubectl'])

function executableBaseName(token: string): string {
  return (token.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '')
}

/** True when a remoting wrapper (`wsl`, `ssh`, ...) sits in the real command
 * chain before `limit`: the first token and tokens behind a PowerShell `&` or
 * sh assignments count as the command head, so `codex -- wsl` (a Codex
 * positional) is not a wrapper, while `cmd /c wsl codex` is. */
export function hasRemotingWrapperBefore(
  tokens: readonly string[],
  shell: AgentStartupShell,
  limit: number
): boolean {
  for (let i = 0; i < Math.min(limit, tokens.length); i += 1) {
    const token = tokens[i]
    if (
      (isPosixStartupShell(shell) && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) ||
      (shell === 'powershell' && token === '&' && i === 0)
    ) {
      continue
    }
    if (token === '--') {
      // Why: everything after a terminator is positional data for the program before it.
      return false
    }
    if (REMOTING_WRAPPERS.has(executableBaseName(token))) {
      return true
    }
  }
  return false
}

const LOCAL_SHELL_WRAPPERS = new Set([
  'cmd',
  'powershell',
  'pwsh',
  'bash',
  'sh',
  'zsh',
  'env',
  'call'
])

/** Index of the first token in command position (after sh assignments / a leading PowerShell `&`). */
function commandHeadIndex(tokens: readonly string[], shell: AgentStartupShell): number {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (
      (isPosixStartupShell(shell) && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) ||
      (shell === 'powershell' && token === '&' && i === 0)
    ) {
      continue
    }
    return i
  }
  return -1
}

export type AgentExecutableLocation = {
  index: number
  /** Offset in the command text right after the executable name. */
  insertAt: number
  /** The executable is the first word inside one quoted payload token (`cmd /c "codex --profile p"`). */
  insidePayload: boolean
}

/** Locates the agent executable this command runs on the local host: in command
 * position (`codex`, `& 'codex'`, `env -- codex`), or handed to a local shell
 * wrapper (`cmd /c codex --`, `powershell -Command codex`, `bash -c "codex -m x"`).
 * A name that is merely an argument of something else (`echo codex`) is not an
 * executable: the head is neither the agent nor a shell. */
export function locateAgentExecutable(
  agent: TuiAgent,
  command: string,
  tokens: readonly string[],
  spans: readonly { start: number; end: number }[],
  shell: AgentStartupShell
): AgentExecutableLocation | null {
  const direct = findStartupCommandExecutableIndex(tokens, shell, (token) =>
    isAgentExecutableToken(agent, token)
  )
  if (direct !== -1) {
    return { index: direct, insertAt: spans[direct].end, insidePayload: false }
  }
  const head = commandHeadIndex(tokens, shell)
  if (head === -1 || !LOCAL_SHELL_WRAPPERS.has(executableBaseName(tokens[head]))) {
    return null
  }
  for (let i = head + 1; i < tokens.length; i += 1) {
    if (isAgentExecutableToken(agent, tokens[i])) {
      return { index: i, insertAt: spans[i].end, insidePayload: false }
    }
    const raw = command.slice(spans[i].start, spans[i].end)
    const payload = /^(["']?)([^\s"']+)\s/.exec(raw)
    if (payload && isAgentExecutableToken(agent, payload[2])) {
      return {
        index: i,
        insertAt: spans[i].start + payload[1].length + payload[2].length,
        insidePayload: true
      }
    }
  }
  return null
}

export function isAgentExecutableToken(agent: TuiAgent, token: string): boolean {
  const base = (token.split(/[\\/]/).pop() ?? '').toLowerCase()
  const names = new Set(
    [TUI_AGENT_CONFIG[agent].launchCmd, TUI_AGENT_CONFIG[agent].detectCmd].map((name) =>
      name.toLowerCase()
    )
  )
  return names.has(base.replace(/\.(exe|cmd|bat|ps1)$/, ''))
}
