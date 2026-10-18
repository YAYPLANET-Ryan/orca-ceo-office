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
import type { TuiAgent } from './tui-agent'

/** Appends the agent's contract `launchArgs` (tui-agent-config.ts) unless the
 * command already carries each of them as its own option token. Used for the
 * fresh launch base and again at resume time, because a command captured before
 * the contract existed (or a user override) may lack them.
 *
 * Placement: options must stay before a `--` terminator, so the args are
 * spliced in front of the first terminator token when one exists; tokens after
 * it are positional and never count as the flag being present. Remote launches
 * are left untouched: the remote CLI version is unknown and an unsupported flag
 * would stop the agent from starting at all. */
export function appendAgentLaunchArgs(
  agent: TuiAgent,
  command: string,
  shell: AgentStartupShell,
  options: { isRemote?: boolean } = {}
): string {
  const launchArgs = TUI_AGENT_CONFIG[agent].launchArgs
  if (!launchArgs?.length || options.isRemote) {
    return command
  }
  const tokenized = tokenizeStartupCommand(command, shell)
  if (!tokenized.ok) {
    // Why: a command this shell cannot tokenize still gets a whitespace-bounded
    // check; for Codex a duplicate flag is harmless while a missing one re-opens
    // the daemon attribution gap.
    const present = new Set(
      command.split(/\s+/).map((token) => token.replace(/^(['"])(.*)\1$/, '$2'))
    )
    const missing = launchArgs.filter((arg) => !present.has(arg))
    return missing.length === 0
      ? command
      : `${command} ${missing.map((arg) => quoteStartupArg(arg, shell)).join(' ')}`
  }
  const terminatorIndex = tokenized.tokens.indexOf('--')
  const optionTokens =
    terminatorIndex === -1 ? tokenized.tokens : tokenized.tokens.slice(0, terminatorIndex)
  const present = new Set(optionTokens)
  const missing = launchArgs.filter((arg) => !present.has(arg))
  if (missing.length === 0) {
    return command
  }
  const inserted = missing.map((arg) => quoteStartupArg(arg, shell)).join(' ')
  if (terminatorIndex === -1) {
    return `${command} ${inserted}`
  }
  const cut = tokenized.spans[terminatorIndex].start
  return `${command.slice(0, cut)}${inserted} ${command.slice(cut)}`
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
    { isRemote: args.isRemote }
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
