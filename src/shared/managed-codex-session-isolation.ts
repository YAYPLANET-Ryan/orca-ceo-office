import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

export function planManagedCodexSessionIsolation(args: {
  cliHelp: string
  configuredArgs: Partial<Record<TuiAgent, string>>
  shell: AgentStartupShell
}): Partial<Record<TuiAgent, string>> {
  if (!/^\s+--no-daemon(?:\s|$)/m.test(args.cliHelp)) {
    throw new Error('Codex does not advertise --no-daemon; keep existing launch settings.')
  }
  const current = args.configuredArgs.codex
  if (typeof current !== 'string') {
    throw new Error('Codex arguments must be explicit; preserve the installed runtime defaults.')
  }
  const parsed = tokenizeStartupCommand(current, args.shell)
  if (!parsed.ok) {
    throw new Error('Codex launch arguments could not be parsed; keep existing launch settings.')
  }
  const terminator = parsed.tokens.indexOf('--')
  const options = terminator === -1 ? parsed.tokens : parsed.tokens.slice(0, terminator)
  if (options.some((token) => token === '--remote' || token.startsWith('--remote='))) {
    throw new Error('Explicit remote Codex launch requires a separate execution-host review.')
  }
  // Why: a shared daemon retains the first pane's hook environment across later TUI clients.
  return {
    ...args.configuredArgs,
    codex: options.includes('--no-daemon') ? current : `--no-daemon ${current}`.trim()
  }
}
