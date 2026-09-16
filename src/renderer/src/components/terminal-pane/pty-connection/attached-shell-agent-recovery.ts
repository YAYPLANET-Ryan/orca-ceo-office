import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { useAppStore } from '@/store'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Resume the saved conversation after a restored local pane is confirmed at its shell. */
export function createAttachedShellAgentRecovery(session: ConnectPanePtySession): () => void {
  let resumeAttempted = false

  return (): void => {
    if (resumeAttempted || session.disposed) {
      return
    }
    resumeAttempted = true
    const ptyId = session.transport.getPtyId()
    const generation = session.transportStreamGeneration
    const lastInputAt = session.lastTerminalInputAt
    const entry = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
    const saved = session.getSleepingRecordForPane(useAppStore.getState())
    const isCurrent = (): boolean =>
      !session.disposed &&
      session.transport.getPtyId() === ptyId &&
      session.transportStreamGeneration === generation &&
      session.lastTerminalInputAt === lastInputAt &&
      useAppStore.getState().agentStatusByPaneKey[session.cacheKey] === entry &&
      session.getSleepingRecordForPane(useAppStore.getState())?.record === saved?.record
    const retire = (): void => {
      // Why: delayed input acknowledgements must not retire a replacement pane or newer hook row.
      if (!isCurrent()) {
        return
      }
      const state = useAppStore.getState()
      state.markSleepingAgentSessionExited(saved?.paneKey ?? session.cacheKey)
      state.dropAgentStatus(session.cacheKey)
      window.api?.agentStatus?.reconcileEndedProcess?.(session.cacheKey)
    }
    if (
      entry &&
      entry.state !== 'done' &&
      isExplicitAgentStatusFresh(entry, Date.now(), AGENT_STATUS_STALE_AFTER_MS)
    ) {
      retire()
      return
    }
    // Why: done means the last turn finished, not that its conversation should be abandoned.
    const startup = session.buildColdRestoreAgentResumeStartup()
    if (!startup || !session.transport.sendInputAccepted) {
      retire()
      return
    }
    void session.transport
      .sendInputAccepted(`${startup.command}\r`)
      .then((accepted: boolean) => {
        if (!isCurrent()) {
          return
        }
        if (!accepted) {
          retire()
          return
        }
        // Why: the existing shell retains the pane's accepted launch token. Type only the exact
        // provider resume command; applying cold-restore env would mint authority for no new PTY.
        session.startAcceptedInferredCommand(startup.agent)
      })
      .catch(retire)
  }
}
