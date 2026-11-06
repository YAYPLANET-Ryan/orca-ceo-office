import { AgentHookServerCleanup } from './server-cleanup'
import type { EnrichedAgentHookEventPayload } from './server-types'

export abstract class AgentHookServerConnectionCleanup extends AgentHookServerCleanup {
  clearStatusEntriesForConnection(connectionId: string): void {
    const normalizedConnectionId = connectionId.trim()
    if (normalizedConnectionId.length === 0) {
      return
    }
    const clearedAt = Math.max(
      Date.now(),
      (this.connectionTimestampWatermarkById.get(normalizedConnectionId) ?? -1) + 1
    )
    this.connectionTimestampWatermarkById.set(normalizedConnectionId, clearedAt)
    let statusChanged = false
    for (const [paneKey, rawEntry] of Array.from(this.state.lastStatusByPaneKey)) {
      const entry = rawEntry as EnrichedAgentHookEventPayload
      // Why: unstamped rows can't be attributed to one host; leave them for normal pane teardown.
      if (entry.connectionId !== normalizedConnectionId) {
        continue
      }
      const deleted = this.deleteStatusEntry(paneKey, { preserveAuthority: true })
      if (deleted) {
        const retained = this.restoreRuntimeResumeCheckpoint(deleted)
        statusChanged = true
        this.commitStatusRowMutation(deleted, retained)
        if (deleted.payload.agentType === 'codex') {
          // A replacement remote process may reuse the pane; discard the lost owner's children.
          this.state.codexSubagentRosterByPaneKey.delete(paneKey)
          this.state.codexLeadStateByPaneKey.delete(paneKey)
        } else if (deleted.payload.agentType === 'claude') {
          this.state.claudeSubagentRosterByPaneKey.delete(paneKey)
          this.state.claudeLeadStateByPaneKey.delete(paneKey)
          this.state.claudeRunningNonAgentTaskPaneKeys.delete(paneKey)
          this.state.claudeActiveSessionCronPaneKeys.delete(paneKey)
          this.state.claudeLaunchedBackgroundTasksByPaneKey.delete(paneKey)
          this.state.claudeSessionOwnerByPaneKey.delete(paneKey)
        }
      }
    }
    for (const [paneKey, evidence] of this.currentAuthorityObservations) {
      if (evidence.connectionId === normalizedConnectionId) {
        this.currentAuthorityObservations.delete(paneKey)
      }
    }
    if (statusChanged) {
      this.scheduleStatusPersist()
      this.notifyStatusChangeListeners()
    }
    // Send the cutoff even with no matched row; another host may have overwritten it.
    this.emitPaneStatusCleared({
      transient: true,
      connectionId: normalizedConnectionId,
      clearedAt
    })
  }
}
