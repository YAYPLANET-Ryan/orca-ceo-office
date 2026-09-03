import { isExplicitAgentStatusFresh } from '@/lib/pane-agent-evidence'
import { useAppStore } from '@/store'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status-types'

import type { ConnectPanePtySession } from './connect-pane-pty-session'

/** Resume a stale nonterminal provider session in a surviving local shell, or retire its ghost row. */
export function createAttachedShellAgentRecovery(session: ConnectPanePtySession): () => void {
  let resumeAttempted = false
  const retire = (): void => {
    useAppStore.getState().dropAgentStatus(session.cacheKey)
    window.api?.agentStatus?.reconcileEndedProcess?.(session.cacheKey)
  }

  return (): void => {
    if (resumeAttempted) {
      return
    }
    const entry = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
    if (
      !entry ||
      entry.state === 'done' ||
      isExplicitAgentStatusFresh(entry, Date.now(), AGENT_STATUS_STALE_AFTER_MS)
    ) {
      retire()
      return
    }
    const startup = session.buildColdRestoreAgentResumeStartup()
    if (!startup || !session.transport.sendInputAccepted) {
      retire()
      return
    }
    resumeAttempted = true
    void session.transport
      .sendInputAccepted(`${startup.command}\r`)
      .then((accepted: boolean) => {
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
