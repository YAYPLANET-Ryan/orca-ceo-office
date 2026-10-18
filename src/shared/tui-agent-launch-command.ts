import {
  removeOverriddenAgentSessionArgs,
  resolveAgentSessionOptionLaunch
} from './agent-session-option-launch'
import type { SessionOptionValue } from './native-chat-session-options'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  planAgentCliArgsSuffix,
  quoteStartupArg,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import { hasRemotingWrapperBefore, locateAgentExecutable } from './agent-launch-executable'
import type { TuiAgent } from './tui-agent'

/** True when the contract `launchArgs` apply: a native Windows host launch.
 * Why: this custom build only certifies the pinned Codex CLI on the Windows
 * host. SSH remotes and WSL run a CLI of unknown version, where an unsupported
 * flag would stop the agent from starting at all; other host platforms keep
 * upstream behavior until their CLI versions are verified. */
export function launchArgsApply(args: { platform: NodeJS.Platform; isRemote?: boolean }): boolean {
  return args.platform === 'win32' && !args.isRemote
}

/** Applies the launch contract of whichever agent a user-authored command runs
 * (quick commands, CLI `--command`, pasted lines, sequenced startup). Returns
 * the command unchanged when no contract agent executable is located. */
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
    if (locateAgentExecutable(agent, command, tokenized.tokens, tokenized.spans, shell)) {
      return appendAgentLaunchArgs(agent, command, shell, { requireLocated: true })
    }
  }
  return command
}

const BARE_ARG = /^[A-Za-z0-9_.=:/-]+$/

/** Appends the agent's contract `launchArgs` (tui-agent-config.ts) unless the
 * command already carries each of them as its own option token. Used for the
 * fresh launch base and again at resume time, because a command captured before
 * the contract existed (or a user override) may lack them.
 *
 * Placement: the args belong to the agent executable, so they are inserted
 * right after it — in command position, behind a local shell wrapper, or as
 * bare words inside the wrapper's one quoted payload token — and tokens after
 * a `--` terminator are positional and never count as the flag being present.
 * A remoting wrapper (`wsl`, `ssh`) before the executable leaves the command
 * alone. When the executable cannot be located, the TUI launch path appends at
 * the end (the override IS the agent command by declaration; a duplicate or
 * unreachable flag is harmless) while `requireLocated` callers get the command
 * back unchanged (`echo codex` is not a Codex launch). A Windows token that
 * diverges from the shell's own parse also falls back to appending: a cut
 * inside unmodeled syntax is not harmless. */
export function appendAgentLaunchArgs(
  agent: TuiAgent,
  command: string,
  shell: AgentStartupShell,
  options: { skip?: boolean; requireLocated?: boolean } = {}
): string {
  const launchArgs = TUI_AGENT_CONFIG[agent].launchArgs
  if (!launchArgs?.length || options.skip) {
    return command
  }
  const quoted = (args: readonly string[]) =>
    args.map((arg) => quoteStartupArg(arg, shell)).join(' ')
  const tokenized = tokenizeStartupCommand(command, shell)
  if (!tokenized.ok) {
    if (options.requireLocated) {
      return command
    }
    const present = new Set(
      command.split(/\s+/).map((token) => token.replace(/^(['"])(.*)\1$/, '$2'))
    )
    const missing = launchArgs.filter((arg) => !present.has(arg))
    return missing.length === 0 ? command : `${command} ${quoted(missing)}`
  }
  const { tokens, spans } = tokenized
  const location = locateAgentExecutable(agent, command, tokens, spans, shell)
  if (!location) {
    if (options.requireLocated || hasRemotingWrapperBefore(tokens, shell, tokens.length)) {
      // Why: `wsl codex` / `ssh host codex` run a CLI whose version this host cannot vouch for.
      return command
    }
    const missing = launchArgs.filter((arg) => !tokens.includes(arg))
    return missing.length === 0 ? command : `${command} ${quoted(missing)}`
  }
  if (hasRemotingWrapperBefore(tokens, shell, location.index)) {
    // Why: `wsl codex` / `ssh host codex` run a CLI whose version this host cannot vouch for.
    return command
  }
  let optionTokens: string[]
  if (location.insidePayload) {
    const span = spans[location.index]
    const words = command
      .slice(span.start, span.end)
      .replace(/^["']|["']$/g, '')
      .split(/\s+/)
    const terminator = words.indexOf('--', 1)
    optionTokens = terminator === -1 ? words : words.slice(0, terminator)
  } else {
    const terminatorIndex = tokens.indexOf('--', location.index + 1)
    optionTokens =
      terminatorIndex === -1
        ? tokens.slice(location.index)
        : tokens.slice(location.index, terminatorIndex)
  }
  const missing = launchArgs.filter((arg) => !optionTokens.includes(arg))
  if (missing.length === 0) {
    return command
  }
  // Why: a Windows token that diverges from the shell's own parse up to the
  // executable falls back to appending, except PowerShell's leading call
  // operator which the tokenizer models.
  const diverges = spans
    .slice(0, location.index + 1)
    .some(
      (span, index) =>
        span.divergesFromShell && !(shell === 'powershell' && index === 0 && tokens[0] === '&')
    )
  if (diverges) {
    return `${command} ${quoted(missing)}`
  }
  if (location.insidePayload) {
    // Why: inside the wrapper's quoted payload the inner shell sees the words
    // verbatim, so only quote-free args can be placed there; anything else is
    // appended outside, where it is harmless.
    if (!missing.every((arg) => BARE_ARG.test(arg))) {
      return `${command} ${quoted(missing)}`
    }
    return `${command.slice(0, location.insertAt)} ${missing.join(' ')}${command.slice(location.insertAt)}`
  }
  return `${command.slice(0, location.insertAt)} ${quoted(missing)}${command.slice(location.insertAt)}`
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
