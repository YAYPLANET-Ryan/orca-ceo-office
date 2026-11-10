/** Env without the launch token, for a start that must not vouch for an agent it did not launch. */
export function withoutLaunchToken(
  env: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!env || !('ORCA_AGENT_LAUNCH_TOKEN' in env)) {
    return env
  }
  const { ORCA_AGENT_LAUNCH_TOKEN: _dropped, ...rest } = env
  return rest
}
