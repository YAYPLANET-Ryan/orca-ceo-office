import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { isPosixStartupShell, type AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

/**
 * Where, in a tokenized startup command, the agent executable actually runs on
 * this host. Shared by the launch contract (tui-agent-launch-command.ts) for
 * ORCA's own launches and for user-authored commands.
 */
const REMOTING_WRAPPERS = new Set(['wsl', 'ssh', 'docker', 'kubectl'])
/** Wrappers that run their first plain argument as the command (after their own options). */
const PASSTHROUGH_WRAPPERS = new Set([
  'env',
  'sudo',
  'nice',
  'nohup',
  'command',
  'exec',
  'time',
  'call'
])
/** Local shells that run a later token, or one quoted payload token, as a command line. */
const LOCAL_SHELL_WRAPPERS = new Set(['cmd', 'powershell', 'pwsh', 'bash', 'sh', 'zsh'])
/** POSIX shells whose `-c` takes exactly one script argument (`bash -c codex`). */
const POSIX_SCRIPT_SHELLS = new Set(['bash', 'sh', 'zsh'])
/** Local-shell options that consume the next token as their operand (PowerShell
 *  names compared case-insensitively; `-Command`/`-c` is the command itself). */
const LOCAL_SHELL_OPERAND_OPTIONS: Record<string, ReadonlySet<string>> = {
  powershell: new Set([
    '-workingdirectory',
    '-wd',
    '-file',
    '-f',
    '-executionpolicy',
    '-ex',
    '-ep',
    '-encodedcommand',
    '-ec',
    '-e',
    '-encodedarguments',
    '-ea',
    '-inputformat',
    '-if',
    '-outputformat',
    '-of',
    '-windowstyle',
    '-w',
    '-version',
    '-v',
    '-psconsolefile',
    '-psc',
    '-configurationname',
    '-config',
    '-settingsfile',
    '-custompipename'
  ]),
  bash: new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']),
  sh: new Set(['-o', '+o']),
  zsh: new Set(['-o', '+o'])
}
LOCAL_SHELL_OPERAND_OPTIONS.pwsh = LOCAL_SHELL_OPERAND_OPTIONS.powershell
/** Local-shell options whose operand IS the command (a script file or an encoded
 *  command): anything after it is that script's argument, never the agent. */
const LOCAL_SHELL_SCRIPT_OPTIONS = new Set(['-file', '-f', '-encodedcommand', '-ec', '-e'])
/** Passthrough-wrapper options that consume the next token as their operand. */
const PASSTHROUGH_OPERAND_OPTIONS: Record<string, ReadonlySet<string>> = {
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
  sudo: new Set(['-u', '-g', '-p', '-C', '-D', '-r', '-t', '-h', '--user', '--group']),
  nice: new Set(['-n', '--adjustment'])
}

function executableBaseName(token: string): string {
  return (token.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '')
}

function isAssignmentToken(token: string, shell: AgentStartupShell): boolean {
  return isPosixStartupShell(shell) && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)
}

function isOptionToken(token: string, shell: AgentStartupShell): boolean {
  return (
    token !== '--' &&
    (token.startsWith('-') || (!isPosixStartupShell(shell) && token.startsWith('/')))
  )
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
    if (isAssignmentToken(token, shell) || (shell === 'powershell' && token === '&' && i === 0)) {
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

/** Index of the first token in command position (after sh assignments / a leading PowerShell `&`). */
function commandHeadIndex(tokens: readonly string[], shell: AgentStartupShell): number {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (isAssignmentToken(token, shell) || (shell === 'powershell' && token === '&' && i === 0)) {
      continue
    }
    return i
  }
  return -1
}

/** The executable in command position: the head itself, or — only behind a
 * passthrough wrapper such as `env`/`sudo` — the first plain token after the
 * wrapper's options and assignments (`env -- codex`, `env FOO=1 codex`). A `--`
 * after anything else (`echo -- codex`) does not reopen command position. */
function findCommandPositionExecutable(
  tokens: readonly string[],
  shell: AgentStartupShell,
  isExecutable: (token: string) => boolean
): number {
  const head = commandHeadIndex(tokens, shell)
  if (head === -1) {
    return -1
  }
  if (isExecutable(tokens[head])) {
    return head
  }
  const wrapper = executableBaseName(tokens[head])
  if (!PASSTHROUGH_WRAPPERS.has(wrapper)) {
    return -1
  }
  const operandOptions = PASSTHROUGH_OPERAND_OPTIONS[wrapper]
  for (let i = head + 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (operandOptions?.has(token)) {
      // Why: `env -u codex echo` names a variable, not a program.
      i += 1
      continue
    }
    if (token === '--' || isAssignmentToken(token, shell) || isOptionToken(token, shell)) {
      continue
    }
    return isExecutable(token) ? i : -1
  }
  return -1
}

export type AgentExecutableLocation = {
  index: number
  /** Offset in the command text right after the executable name. */
  insertAt: number
  /** The executable is the first word inside one quoted payload token (`cmd /c "codex --profile p"`). */
  insidePayload: boolean
  /** The executable is the bare script argument of a POSIX `-c` (`bash -c codex`): args
   *  appended as further tokens would become the script's `$0`, so the token itself must
   *  be rewritten into a quoted script. */
  scriptArgument: boolean
}

/** Locates the agent executable this command runs on the local host: in command
 * position (`codex`, `& 'codex'`, `env -- codex`), or as the command a local
 * shell wrapper runs — its first plain token after the wrapper's options
 * (`cmd /c codex --`, `powershell -NoProfile -Command codex`) or the first word
 * of its one quoted payload token (`bash -c "codex -m x"`). A name that is an
 * argument of something else (`echo codex`, `cmd /c echo codex`) is never one. */
export function locateAgentExecutable(
  agent: TuiAgent,
  command: string,
  tokens: readonly string[],
  spans: readonly { start: number; end: number }[],
  shell: AgentStartupShell
): AgentExecutableLocation | null {
  const direct = findCommandPositionExecutable(tokens, shell, (token) =>
    isAgentExecutableToken(agent, token)
  )
  if (
    direct !== -1 &&
    shell === 'powershell' &&
    tokens[0] !== '&' &&
    /^["']/.test(command.slice(spans[direct].start, spans[direct].end))
  ) {
    // Why: PowerShell evaluates `'codex'` or `"C:\x\codex.exe"` in command position
    // as a string expression; only the call operator (`& 'codex'`) runs it.
    return null
  }
  if (direct !== -1) {
    return {
      index: direct,
      insertAt: spans[direct].end,
      insidePayload: false,
      scriptArgument: false
    }
  }
  const head = commandHeadIndex(tokens, shell)
  const wrapper = head === -1 ? '' : executableBaseName(tokens[head])
  if (head === -1 || !LOCAL_SHELL_WRAPPERS.has(wrapper)) {
    return null
  }
  const operandOptions = LOCAL_SHELL_OPERAND_OPTIONS[wrapper]
  const posixScriptShell = POSIX_SCRIPT_SHELLS.has(wrapper)
  let sawScriptFlag = false
  for (let i = head + 1; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (
      (wrapper === 'powershell' || wrapper === 'pwsh') &&
      LOCAL_SHELL_SCRIPT_OPTIONS.has(token.toLowerCase())
    ) {
      // Why: `pwsh -File script.ps1 codex` runs the script; `codex` is its argument.
      return null
    }
    if (operandOptions?.has(token.toLowerCase())) {
      // Why: `pwsh -WorkingDirectory C:\tools\codex -Command claude` names a directory, not a program.
      i += 1
      continue
    }
    if (isOptionToken(token, shell)) {
      // Why: `-c` may ride anywhere among the wrapper's options (`bash -c -l codex`,
      // `bash -lc`, `bash -cl`); the script is still the first plain token.
      sawScriptFlag ||= posixScriptShell && /^-[A-Za-z]*c[A-Za-z]*$/.test(token)
      continue
    }
    const raw = command.slice(spans[i].start, spans[i].end)
    if (isAgentExecutableToken(agent, token)) {
      return {
        index: i,
        insertAt: spans[i].end,
        insidePayload: false,
        // Why: the inner shell's grammar decides, whatever the outer pane shell is:
        // `bash -c codex` and `bash -c 'codex'` both run the token as the script.
        scriptArgument: sawScriptFlag
      }
    }
    const payload = /^(["']?)([^\s"']+)\s/.exec(raw)
    if (payload && isAgentExecutableToken(agent, payload[2])) {
      return {
        index: i,
        insertAt: spans[i].start + payload[1].length + payload[2].length,
        insidePayload: true,
        scriptArgument: false
      }
    }
    // Why: the wrapper's command is its first plain token; anything the agent
    // name appears in after that is that command's argument.
    return null
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
