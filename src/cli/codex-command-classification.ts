// Shared with host-side hook admission; keep the CLI import path stable.
export {
  readCodexCommandMode,
  shouldUseRendererBackedCodexTerminal,
  shouldUseRendererBackedInteractiveTerminal
} from '../shared/agent-status/process/codex-command-classification'
