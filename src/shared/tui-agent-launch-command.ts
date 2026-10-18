import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'
import type { SessionOptionValue } from './native-chat-session-options'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  findStartupCommandExecutableIndex,
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

/** True when the command position holds a wrapper that runs the rest somewhere
 * else (`wsl codex`, `ssh host codex`): the local CLI contract must not follow. */
function startsWithRemotingWrapper(tokens: readonly string[], shell: AgentStartupShell): boolean {
  const index = findStartupCommandExecutableIndex(tokens, shell, (token) =>
    REMOTING_WRAPPERS.has(
      (token.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/\.(exe|cmd|bat)$/, '')
    )
  )
  return index !== -1
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
    const index = findStartupCommandExecutableIndex(tokenized.tokens, shell, (token) =>
      isAgentExecutableToken(agent, token)
    )
    if (index !== -1) {
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
  if (startsWithRemotingWrapper(tokenized.tokens, shell)) {
    // Why: `wsl codex` / `ssh host codex` run a CLI whose version this host cannot vouch for.
    return command
  }
  const executableIndex = findStartupCommandExecutableIndex(tokenized.tokens, shell, (token) =>
    isAgentExecutableToken(agent, token)
  )
  const terminatorIndex =
    executableIndex === -1 ? -1 : tokenized.tokens.indexOf('--', executableIndex + 1)
  const optionTokens =
    terminatorIndex === -1
      ? tokenized.tokens.slice(Math.max(executableIndex, 0))
      : tokenized.tokens.slice(executableIndex, terminatorIndex)
  const missing = launchArgs.filter((arg) => !optionTokens.includes(arg))
  if (missing.length === 0) {
    return command
  }
  // Why: PowerShell's leading call operator is the one divergent token the tokenizer models safely (see agent-resume-launch-command.ts).
  const spliceable =
    terminatorIndex !== -1 &&
    !tokenized.spans
      .slice(0, terminatorIndex + 1)
      .some(
        (span, index) =>
          span.divergesFromShell &&
          !(shell === 'powershell' && index === 0 && tokenized.tokens[0] === '&')
      )
  if (!spliceable) {
    return `${command} ${quoted(missing)}`
  }
  const cut = tokenized.spans[terminatorIndex].start
  return `${command.slice(0, cut)}${quoted(missing)} ${command.slice(cut)}`
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
