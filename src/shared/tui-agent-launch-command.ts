import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'
import type { SessionOptionValue } from './native-chat-session-options'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  findStartupCommandExecutableIndex,
  isPosixStartupShell,
  planAgentCliArgsSuffix,
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

/** True when the contract `launchArgs` apply: a native Windows host launch.
 * Why: this custom build only certifies the pinned Codex CLI on the Windows
 * host. SSH remotes and WSL run a CLI of unknown version, where an unsupported
 * flag would stop the agent from starting at all; other host platforms keep
 * upstream behavior until their CLI versions are verified. */
export function launchArgsApply(args: { platform: NodeJS.Platform; isRemote?: boolean }): boolean {
  return args.platform === 'win32' && !args.isRemote
}

const REMOTING_WRAPPERS = new Set(['wsl', 'ssh', 'docker', 'kubectl'])

function executableBaseName(token: string): string {
  return (token.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '')
}

/** True when a remoting wrapper (`wsl`, `ssh`, ...) sits in the real command
 * chain before `limit`: the first token and tokens behind a PowerShell `&` or
 * sh assignments count as the command head, so `codex -- wsl` (a Codex
 * positional) is not a wrapper, while `cmd /c wsl codex` is. */
function hasRemotingWrapperBefore(
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

/** Applies the launch contract of whichever agent sits in command position of a
 * user-authored command (quick commands, CLI `--command`, pasted lines). Returns
 * the command unchanged when no contract agent is found there. */
export function applyAgentLaunchArgsToCustomCommand(
  command: string,
  shell: AgentStartupShell,
  host: { platform: NodeJS.Platform; isRemote?: boolean }
): string {
  if (!launchArgsApply(host) || !command.trim()) {
    return command
  }
  const tokenized = tokenizeStartupCommand(command, shell)
  if (!tokenized.ok) {
    return command
  }
  for (const agent of Object.keys(TUI_AGENT_CONFIG) as TuiAgent[]) {
    if (!TUI_AGENT_CONFIG[agent].launchArgs?.length) {
      continue
    }
    // Why: a local shell wrapper (`cmd /c codex`) still reaches the agent; appendAgentLaunchArgs
    // decides placement and refuses remoting wrappers itself.
    if (tokenized.tokens.some((token) => isAgentExecutableToken(agent, token))) {
      return appendAgentLaunchArgs(agent, command, shell)
    }
  }
  return command
}

function isAgentExecutableToken(agent: TuiAgent, token: string): boolean {
  const base = (token.split(/[\\/]/).pop() ?? '').toLowerCase()
  const names = new Set(
    [TUI_AGENT_CONFIG[agent].launchCmd, TUI_AGENT_CONFIG[agent].detectCmd].map((name) =>
      name.toLowerCase()
    )
  )
  return names.has(base.replace(/\.(exe|cmd|bat|ps1)$/, ''))
}

/** Appends the agent's contract `launchArgs` (tui-agent-config.ts) unless the
 * command already carries each of them as its own option token. Used for the
 * fresh launch base and again at resume time, because a command captured before
 * the contract existed (or a user override) may lack them.
 *
 * Placement: the args belong to the agent executable, so they are spliced in
 * front of the first `--` terminator that follows the executable token; tokens
 * after that terminator are positional and never count as the flag being
 * present. When the executable cannot be located in command position (a wrapper
 * such as `bash -c "codex"`), or a Windows token diverges from the shell's own
 * parse, the args are appended at the end as before: a duplicate or unreachable
 * flag is harmless, a cut inside unmodeled syntax is not. */
export function appendAgentLaunchArgs(
  agent: TuiAgent,
  command: string,
  shell: AgentStartupShell,
  options: { skip?: boolean } = {}
): string {
  const launchArgs = TUI_AGENT_CONFIG[agent].launchArgs
  if (!launchArgs?.length || options.skip) {
    return command
  }
  const quoted = (args: readonly string[]) =>
    args.map((arg) => quoteStartupArg(arg, shell)).join(' ')
  const tokenized = tokenizeStartupCommand(command, shell)
  if (!tokenized.ok) {
    const present = new Set(
      command.split(/\s+/).map((token) => token.replace(/^(['"])(.*)\1$/, '$2'))
    )
    const missing = launchArgs.filter((arg) => !present.has(arg))
    return missing.length === 0 ? command : `${command} ${quoted(missing)}`
  }
  const { tokens, spans } = tokenized
  // Why: the executable may sit in command position (`codex`, `& 'codex'`) or be
  // handed to a local shell wrapper (`cmd /c codex --`, `powershell -Command codex`);
  // both reach Codex on this host. A remoting wrapper before it does not.
  let executableIndex = findStartupCommandExecutableIndex(tokens, shell, (token) =>
    isAgentExecutableToken(agent, token)
  )
  if (executableIndex === -1) {
    executableIndex = tokens.findIndex((token) => isAgentExecutableToken(agent, token))
  }
  if (executableIndex === -1) {
    const missing = launchArgs.filter((arg) => !tokens.includes(arg))
    return missing.length === 0 ? command : `${command} ${quoted(missing)}`
  }
  if (hasRemotingWrapperBefore(tokens, shell, executableIndex)) {
    // Why: `wsl codex` / `ssh host codex` run a CLI whose version this host cannot vouch for.
    return command
  }
  const terminatorIndex = tokens.indexOf('--', executableIndex + 1)
  const optionTokens =
    terminatorIndex === -1
      ? tokens.slice(executableIndex)
      : tokens.slice(executableIndex, terminatorIndex)
  const missing = launchArgs.filter((arg) => !optionTokens.includes(arg))
  if (missing.length === 0) {
    return command
  }
  // Why: insert right after the executable token so the args stay options even
  // when a `--` terminator or a positional prompt follows; a Windows token that
  // diverges from the shell's own parse up to there falls back to appending,
  // except PowerShell's leading call operator which the tokenizer models.
  const diverges = spans
    .slice(0, executableIndex + 1)
    .some(
      (span, index) =>
        span.divergesFromShell && !(shell === 'powershell' && index === 0 && tokens[0] === '&')
    )
  if (diverges) {
    return `${command} ${quoted(missing)}`
  }
  const insertAt = spans[executableIndex].end
  return `${command.slice(0, insertAt)} ${quoted(missing)}${command.slice(insertAt)}`
}

export type ResolvedAgentLaunchCommand =
  | {
      ok: true
      command: string
      commandWithoutSessionOptions: string
      appliedSessionOptions: Record<string, SessionOptionValue>
    }
  | { ok: false; error: string }

export function resolveAgentLaunchCommand(args: {
  agent: TuiAgent
  cmdOverrides: Partial<Record<TuiAgent, string>>
  platform: NodeJS.Platform
  shell: AgentStartupShell
  agentArgs?: string | null
  sessionOptions?: Record<string, SessionOptionValue>
  sessionOptionsOverrideAgentArgs?: boolean
  isRemote?: boolean
}): ResolvedAgentLaunchCommand {
  const override = args.cmdOverrides[args.agent]
  // Why: contract args ride in the base command (not the picker/session-option
  // suffix) so the command captured for resume keeps them too.
  const command = appendAgentLaunchArgs(
    args.agent,
    override ||
      getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[args.agent], args.platform, {
        isRemote: args.isRemote
      }),
    args.shell,
    { skip: !launchArgsApply({ platform: args.platform, isRemote: args.isRemote }) }
  )
  const suffix = planAgentCliArgsSuffix(args.agentArgs, args.shell)
  if (!suffix.ok) {
    return suffix
  }
  const trailingTokens = args.agentArgs?.trim()
    ? tokenizeStartupCommand(args.agentArgs.trim(), args.shell)
    : { ok: true as const, tokens: [], spans: [] }
  if (!trailingTokens.ok) {
    return { ok: false, error: `CLI arguments are invalid: ${trailingTokens.error}` }
  }
  const resolvedOptions = resolveAgentSessionOptionLaunch(
    args.agent,
    args.sessionOptions,
    args.sessionOptionsOverrideAgentArgs ? [] : trailingTokens.tokens,
    !args.sessionOptionsOverrideAgentArgs
  )
  if (override && args.sessionOptionsOverrideAgentArgs) {
    const overrideTokens = tokenizeStartupCommand(override, args.shell)
    if (!overrideTokens.ok) {
      return { ok: false, error: `Agent command override is invalid: ${overrideTokens.error}` }
    }
    const commandOverrideOptions = resolveAgentSessionOptionLaunch(
      args.agent,
      args.sessionOptions,
      overrideTokens.tokens,
      false
    )
    if (
      Object.entries(resolvedOptions.appliedValues).some(
        ([key, value]) => commandOverrideOptions.appliedValues[key] !== value
      )
    ) {
      return {
        ok: false,
        error:
          'Agent command override conflicts with the requested launch preferences. Remove model or effort flags from the command override.'
      }
    }
  }
  const optionSuffix = resolvedOptions.args.map((arg) => quoteStartupArg(arg, args.shell)).join(' ')
  const commandWithoutSessionOptions = suffix.suffix ? `${command} ${suffix.suffix}` : command
  const commandWithOptions = optionSuffix ? `${command} ${optionSuffix}` : command
  const overrideTokens = args.sessionOptionsOverrideAgentArgs
    ? insertBeforeTerminator(
        removeOverriddenAgentSessionArgs(args.agent, args.sessionOptions, trailingTokens.tokens),
        resolvedOptions.args
      )
    : []
  const commandWithOverrides = overrideTokens.length
    ? `${command} ${overrideTokens.map((token) => quoteStartupArg(token, args.shell)).join(' ')}`
    : command
  return {
    ok: true,
    command: args.sessionOptionsOverrideAgentArgs
      ? commandWithOverrides
      : suffix.suffix
        ? `${commandWithOptions} ${suffix.suffix}`
        : commandWithOptions,
    commandWithoutSessionOptions,
    appliedSessionOptions: resolvedOptions.appliedValues
  }
}

function insertBeforeTerminator(tokens: readonly string[], inserted: readonly string[]): string[] {
  const terminator = tokens.indexOf('--')
  if (terminator === -1) {
    return [...tokens, ...inserted]
  }
  return [...tokens.slice(0, terminator), ...inserted, ...tokens.slice(terminator)]
}
