import { agentProviderSessionsEqual, type SleepingAgentSessionRecord } from './agent-session-resume'

export function confirmRecoverySources(
  records: Record<string, SleepingAgentSessionRecord>,
  previous: SleepingAgentSessionRecord | undefined,
  confirmed: SleepingAgentSessionRecord | null
): Record<string, SleepingAgentSessionRecord> {
  if (
    !previous ||
    previous.resumeTargetPaneKey !== previous.paneKey ||
    !confirmed ||
    confirmed.paneKey !== previous.paneKey ||
    confirmed.agent !== previous.agent ||
    confirmed.worktreeId !== previous.worktreeId ||
    !agentProviderSessionsEqual(previous.agent, previous.providerSession, confirmed.providerSession)
  ) {
    return records
  }
  let next = records
  for (const [key, source] of Object.entries(records)) {
    if (
      key === confirmed.paneKey ||
      source.resumeTargetPaneKey !== confirmed.paneKey ||
      source.resumeConfirmedAt ||
      source.worktreeId !== confirmed.worktreeId ||
      source.agent !== confirmed.agent ||
      !agentProviderSessionsEqual(source.agent, source.providerSession, confirmed.providerSession)
    ) {
      continue
    }
    if (next === records) {
      next = { ...records }
    }
    next[key] = { ...source, resumeConfirmedAt: confirmed.updatedAt }
  }
  return next
}

export function remapRecoveryTargets(
  records: Record<string, SleepingAgentSessionRecord>,
  from: string,
  to: string
): Record<string, SleepingAgentSessionRecord> {
  let next = records
  for (const [key, record] of Object.entries(records)) {
    if (record.resumeTargetPaneKey !== from) {
      continue
    }
    if (next === records) {
      next = { ...records }
    }
    next[key] = { ...record, resumeTargetPaneKey: to }
  }
  return next
}
