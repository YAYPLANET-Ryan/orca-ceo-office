import type { ClaimedAgentPtyOwnerRegistry } from '../../../shared/claimed-agent-pty-owner'
import type { Session } from '../sessions/session'
import type { SessionInfo } from '../protocol/daemon-session-info'
import type { WslGuestRoot } from '../../../shared/wsl-guest-root-marker'
import type { HookResumeIntent } from '../../../shared/agent-hook-listener/state/hook-resume-intent'
import { getSessionProviderObservation } from './terminal-host-provider-observation'
import { getSessionHookContext } from './terminal-host-hook-context'
export { recordSessionSpawnPaneKey } from './terminal-host-hook-context'

export function getSessionHookResumeIntent(session: Session): HookResumeIntent | null | undefined {
  const observation = getSessionProviderObservation(session)
  return observation
    ? { agentType: observation.agentType, providerSessionId: observation.providerSessionId }
    : getSessionHookContext(session).context?.resumeIntent
}

const wslGuestRoots = new WeakMap<Session, WslGuestRoot>()

/** A WSL session's guest root shell, as its own launch output reported it. */
export function recordSessionWslGuestRoot(session: Session, root: WslGuestRoot): void {
  wslGuestRoots.set(session, root)
}

export function listLiveTerminalHostSessions(
  sessions: ReadonlyMap<string, Session>,
  agentSessionOwners: ClaimedAgentPtyOwnerRegistry,
  attachmentFor?: (id: string) => symbol | undefined
): SessionInfo[] {
  const result: SessionInfo[] = []
  for (const session of sessions.values()) {
    if (!session.isAlive) {
      continue
    }
    const size = session.getAppliedSize()
    const { paneKey, context: hookContext } = getSessionHookContext(session)
    const providerObservation = getSessionProviderObservation(session)
    const attachment = attachmentFor?.(session.sessionId)
    const wslGuestRoot = wslGuestRoots.get(session)
    const foregroundProcess = session.getForegroundProcess({ cachedOnly: true })
    result.push({
      sessionId: session.sessionId,
      ...(foregroundProcess ? { foregroundProcess } : {}),
      incarnationId: session.incarnationId,
      // Terminating sessions still count as live but must not be adopted or restored.
      state: session.isTerminating ? 'exiting' : session.state,
      shellState: session.shellState,
      isAlive: true,
      ...(session.terminalHandle ? { terminalHandle: session.terminalHandle } : {}),
      ...(paneKey ? { paneKey } : {}),
      ...(hookContext ? { hookContext: { ...hookContext } } : {}),
      ...(providerObservation ? { providerObservation } : {}),
      ...(attachmentFor
        ? { attachedToRequester: Boolean(attachment && session.hasAttachedClient(attachment)) }
        : {}),
      wslDistro: session.wslDistro,
      ...(wslGuestRoot ? { wslGuestRoot } : {}),
      pid: session.pid,
      cwd: session.getCwd(),
      cols: size?.cols ?? 0,
      rows: size?.rows ?? 0,
      createdAt: 0,
      agentSessionOwners: agentSessionOwners.listForPty(session.sessionId)
    })
  }
  return result
}

export function hasLiveTerminalHostSessions(sessions: ReadonlyMap<string, Session>): boolean {
  let hasLive = false
  // Read every Session to preserve inventory error order.
  for (const session of sessions.values()) {
    hasLive = session.isAlive || hasLive
  }
  return hasLive
}
