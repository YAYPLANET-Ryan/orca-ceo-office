import { useAppStore } from '@/store'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { isCodexPaneStale } from './codex-pane-stale'
import {
  registerPaneConversationRecovery,
  type ConversationRecoveryResult
} from '@/lib/pane-conversation-recovery'
import { isShellProcess } from '../../../../../shared/shell-process-detection'
import { agentProviderSessionsEqual } from '../../../../../shared/agent-session-resume'
import { withTimeout } from '../../../../../shared/promise-timeout-fallback'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

export function installManualConversationRecovery(session: ConnectPanePtySession): void {
  let pending = false
  let submittedRecord: unknown
  let submittedShellSequence: number | undefined
  const recover = async (): Promise<ConversationRecoveryResult> => {
    const saved = session.getSleepingRecordForPane(useAppStore.getState())
    if (
      pending ||
      (saved?.record &&
        submittedRecord === saved.record &&
        submittedShellSequence === session.recoveryShellSequence)
    ) {
      return 'busy'
    }
    const ptyId = session.transport.getPtyId()
    const inputBlocked = (): boolean =>
      Boolean(
        ptyId &&
        (isPtyLocked(ptyId) ||
          isCodexPaneStale({
            tabId: session.deps.tabId,
            worktreeId: session.deps.worktreeId,
            panePtyId: ptyId
          }))
      )
    if (
      session.disposed ||
      inputBlocked() ||
      !ptyId ||
      !session.isForegroundTrackingAllowed(ptyId) ||
      !session.transport.sendInputAccepted ||
      !saved?.record ||
      (saved.record.resumeTargetPaneKey && saved.record.resumeTargetPaneKey !== session.cacheKey) ||
      saved.record.automaticResumeBlockedBy ||
      session.pendingStartupCommand
    ) {
      return 'unavailable'
    }
    // Why: a shell may contain an unfinished user command; never append resume to it.
    if (session.recoveryShellInputAt !== session.lastTerminalInputAt) {
      return 'changed'
    }
    const generation = session.transportStreamGeneration
    const inputAt = session.lastTerminalInputAt
    const entry = useAppStore.getState().agentStatusByPaneKey[session.cacheKey]
    const current = (): boolean =>
      !session.disposed &&
      !inputBlocked() &&
      session.transport.getPtyId() === ptyId &&
      session.transportStreamGeneration === generation &&
      session.lastTerminalInputAt === inputAt &&
      useAppStore.getState().agentStatusByPaneKey[session.cacheKey] === entry &&
      session.getSleepingRecordForPane(useAppStore.getState())?.record === saved.record
    pending = true
    try {
      const foreground = await withTimeout(
        window.api.pty.confirmForegroundProcess(ptyId),
        10_000,
        null
      )
      if (!current()) {
        return 'changed'
      }
      if (!foreground || !isShellProcess(foreground)) {
        return 'unavailable'
      }
      const startup = session.buildColdRestoreAgentResumeStartup({ manual: true })
      if (
        !startup ||
        !current() ||
        startup.agent !== saved.record.agent ||
        !agentProviderSessionsEqual(
          startup.agent,
          startup.resumeProviderSession,
          saved.record.providerSession
        )
      ) {
        return 'unavailable'
      }
      submittedRecord = saved.record
      submittedShellSequence = session.recoveryShellSequence
      const accepted = await withTimeout<boolean | null>(
        session.transport.sendInputAccepted(`${startup.command}\r`),
        10_000,
        null
      )
      if (!current()) {
        return 'changed'
      }
      if (accepted === null) {
        return 'uncertain'
      }
      if (!accepted) {
        submittedRecord = undefined
        return 'unavailable'
      }
      // Why: delivery is not provider confirmation; keep the durable record and prevent double clicks.
      submittedRecord = saved.record
      session.startAcceptedInferredCommand(startup.agent)
      return 'submitted'
    } catch {
      return submittedRecord === saved.record ? 'uncertain' : 'unavailable'
    } finally {
      pending = false
    }
  }
  session.waitTeardowns.push(registerPaneConversationRecovery(session.cacheKey, recover))
}
