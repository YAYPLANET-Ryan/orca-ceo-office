import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { isResumableTuiAgent } from '../../../../shared/agent-session-resume'
import type { AgentStatusBatchUpdate } from '@/store/slices/agent-status'

export function providerSessionStatusUpdate(
  data: AgentStatusIpcPayload,
  paneKey: string,
  ownerTabId: string | undefined,
  owningWorktreeId: string | undefined,
  connectionId: string | null | undefined
): Extract<AgentStatusBatchUpdate, { kind: 'providerSession' }> | null {
  if (
    (data.retainedForLiveness === true && data.runtimeResumeCheckpoint !== true) ||
    !data.providerSession ||
    !isResumableTuiAgent(data.agentType)
  ) {
    return null
  }
  return {
    kind: 'providerSession',
    paneKey,
    agent: data.agentType,
    providerSession: data.providerSession,
    timing: { updatedAt: data.receivedAt },
    routing: {
      tabId: ownerTabId,
      worktreeId: data.worktreeId ?? owningWorktreeId,
      ...(connectionId !== undefined ? { connectionId } : {})
    },
    metadata: {
      ...(data.launchToken ? { launchToken: data.launchToken } : {}),
      ...(data.observation?.origin === 'launch' ? { preserveLiveStatus: true } : {}),
      ...(data.runtimeResumeCheckpoint === true ? { preserveResumeCheckpoint: true } : {})
    }
  }
}
