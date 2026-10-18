import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus,
  type AgentStatusState,
  type AgentType
} from './agent-status-types'

type ExistingAgentIdentity = {
  agentType?: AgentType
  state: AgentStatusState
  updatedAt: number
  restoredUnconfirmed?: boolean
}

type AgentIdentityResolution = {
  agentType: AgentType
  inheritedFromActivePane: boolean
}

/** Process-table evidence for the pane (renderer pane-foreground-agent slice):
 * which agent owns the PTY foreground and whether the shell has since returned. */
export type PaneForegroundEvidence = {
  agent: AgentType | null
  shellForeground: boolean
}

export function shouldSuppressInheritedTerminalStatus(args: {
  inheritedFromActivePane: boolean
  incomingState: AgentStatusState
}): boolean {
  // Why: nested child hooks inherit the parent's ORCA_PANE_KEY. A child
  // completion does not prove the active parent turn completed.
  return args.inheritedFromActivePane && args.incomingState === 'done'
}

function normalizedKnownAgentType(agentType: AgentType | null | undefined): AgentType | null {
  if (!agentType || agentType === 'unknown') {
    return null
  }
  return agentType
}

function isActiveExistingIdentity(
  existing: ExistingAgentIdentity,
  now: number,
  staleAfterMs: number
): boolean {
  return isFreshNonDoneAgentStatus(existing, now, staleAfterMs)
}

export function resolveAgentStatusIdentity(args: {
  existing?: ExistingAgentIdentity
  incoming?: AgentType
  now: number
  staleAfterMs?: number
  foreground?: PaneForegroundEvidence | null
}): AgentIdentityResolution {
  const staleAfterMs = args.staleAfterMs ?? AGENT_STATUS_STALE_AFTER_MS
  const existingAgentType = normalizedKnownAgentType(args.existing?.agentType)
  const incomingAgentType = normalizedKnownAgentType(args.incoming)

  if (!incomingAgentType) {
    return {
      agentType: existingAgentType ?? 'unknown',
      inheritedFromActivePane: false
    }
  }
  if (!args.existing || !existingAgentType || existingAgentType === incomingAgentType) {
    return {
      agentType: incomingAgentType,
      inheritedFromActivePane: false
    }
  }
  if (isActiveExistingIdentity(args.existing, args.now, staleAfterMs)) {
    return {
      // Why: child agent CLIs inherit ORCA_PANE_KEY from their parent terminal.
      // While the parent turn is active, do not let a nested hook steal the
      // pane's visible identity.
      agentType: existingAgentType,
      inheritedFromActivePane: true
    }
  }
  if (
    args.foreground?.agent &&
    args.foreground.agent === existingAgentType &&
    !args.foreground.shellForeground
  ) {
    return {
      // Why: an idle parent (Claude sitting at its prompt) still owns the PTY
      // foreground; a `codex exec` it runs inherits the pane key and must not
      // rewrite the pane's identity or its resumable session. Only the shell
      // returning (OSC 133;D) proves the parent exited and lets a new agent in.
      agentType: existingAgentType,
      inheritedFromActivePane: true
    }
  }

  return {
    agentType: incomingAgentType,
    inheritedFromActivePane: false
  }
}
