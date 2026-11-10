import { agentProviderSessionsEqual, type SleepingAgentSessionRecord } from './agent-session-resume'
import type { AgentStatusEntry } from '../../agent-status/contracts/agent-status-types'

/**
 * Whether an exited conversation's fence still holds against a status of its pane. The fence's
 * capturedAt is the exit time, so only a status of the same session received after it proves the
 * agent runs again; a stale or replayed row from before the exit does not.
 */
export function exitFenceHolds(
  record: SleepingAgentSessionRecord | undefined,
  status: Pick<AgentStatusEntry, 'agentType' | 'updatedAt'> &
    Partial<Pick<AgentStatusEntry, 'providerSession'>>
): boolean {
  return (
    record?.requiresManualResume === true &&
    record.agent === status.agentType &&
    (!status.providerSession ||
      agentProviderSessionsEqual(record.agent, record.providerSession, status.providerSession)) &&
    status.updatedAt <= record.capturedAt
  )
}
