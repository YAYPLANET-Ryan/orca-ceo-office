/**
 * A pane is a protected Claude/Codex context when any live row names Claude or Codex, or when it holds a
 * provider identity and no live row proves another known agent owns it. Identity rows carry no agent type,
 * so 'unknown' and missing agent types stay protected.
 */
export function isClaudeOrCodexContext(
  agentTypes: readonly unknown[],
  hasProviderIdentity: () => boolean
): boolean {
  if (agentTypes.some((agent) => agent === 'claude' || agent === 'codex')) {
    return true
  }
  const anotherKnownAgent =
    agentTypes.length > 0 &&
    agentTypes.every((agent) => typeof agent === 'string' && agent !== 'unknown')
  return !anotherKnownAgent && hasProviderIdentity()
}
