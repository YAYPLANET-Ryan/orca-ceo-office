import { useAppStore } from '@/store/index'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession
} from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { ColdRestoreAgentResumeStartup, FreshSpawnOptions } from './fresh-spawn-types'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

type AppState = ReturnType<typeof useAppStore.getState>

/**
 * Whether a lost agent pane must come back as a shell: its conversation was exited, or no exact
 * provider session names it. Replaying the tab's `claude`/`codex` launch would silently open a new
 * conversation and hide the one the user is looking for.
 */
export function coldRestoreRequiresManualResume(
  session: ConnectPanePtySession,
  state: AppState
): boolean {
  if (session.pendingStartupCommand) {
    return false
  }
  const sleepingRecord = session.getSleepingRecordForPane(state)?.record
  if (sleepingRecord?.requiresManualResume === true) {
    return true
  }
  const entry = state.agentStatusByPaneKey[session.cacheKey]
  const liveEntry = entry && (entry.state !== 'done' || !sleepingRecord) ? entry : null
  const agent =
    (liveEntry ? liveEntry.agentType : sleepingRecord?.agent) ??
    session.resolveExpectedLaunchTuiAgent()
  if (!agent || !isResumableTuiAgent(agent)) {
    return false
  }
  return (
    normalizeAgentProviderSession(
      liveEntry ? liveEntry.providerSession : sleepingRecord?.providerSession
    ) === null
  )
}

/** Restarts the pane as a plain shell with a resume-required banner; null when the normal start applies. */
export function startShellWhenResumeRequired(
  session: ConnectPanePtySession,
  startup: ColdRestoreAgentResumeStartup | null,
  options: FreshSpawnOptions
): Promise<string | null> | null {
  if (startup || !coldRestoreRequiresManualResume(session, useAppStore.getState())) {
    return null
  }
  return session
    .spawnColdRestoreAgentResume(null, {
      ...options,
      inheritStartupCommand: false
    })
    .then((ptyId) => {
      if (ptyId) {
        session.showSessionRestoredBanner('resume-required')
      }
      return ptyId
    })
}

/** A daemon reattach whose lost pane must cold-restore as a shell rather than replay its launch. */
export function reattachRequiresManualResume(
  session: ConnectPanePtySession,
  attachOnlyView: boolean,
  resumeStartup: ColdRestoreAgentResumeStartup | null
): boolean {
  return (
    !attachOnlyView &&
    !resumeStartup &&
    coldRestoreRequiresManualResume(session, useAppStore.getState())
  )
}

export function isColdRestoreResult(result: unknown): boolean {
  return Boolean(
    result && typeof result === 'object' && 'coldRestore' in result && result.coldRestore
  )
}
