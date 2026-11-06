import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { getProviderSessionClaimKey } from './sleeping-agent-pane-ownership'

/** Includes orphaned records: visibility must not depend on an existing pane. */
export function pendingConversationRecoveries(
  records: Record<string, SleepingAgentSessionRecord>,
  worktreeId: string
): SleepingAgentSessionRecord[] {
  const byProvider = new Map<string, SleepingAgentSessionRecord>()
  for (const record of Object.values(records)) {
    if (
      record.worktreeId !== worktreeId ||
      !record.resumeTargetPaneKey ||
      record.resumeConfirmedAt
    ) {
      continue
    }
    const key = getProviderSessionClaimKey(record)
    const destination = records[record.resumeTargetPaneKey]
    if (
      destination &&
      !destination.resumeTargetPaneKey &&
      getProviderSessionClaimKey(destination) === key
    ) {
      continue
    }
    const previous = byProvider.get(key)
    if (!previous || record.paneKey === record.resumeTargetPaneKey) {
      byProvider.set(key, record)
    }
  }
  return [...byProvider.values()]
}
