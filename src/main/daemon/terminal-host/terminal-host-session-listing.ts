import type { ClaimedAgentPtyOwnerRegistry } from '../../../shared/claimed-agent-pty-owner'
import type { Session } from '../sessions/session'
import type { SessionInfo } from '../protocol/daemon-session-info'
import type { WslGuestRoot } from '../../../shared/wsl-guest-root-marker'
import { readWindowsProcessCreationKey } from '../../windows/windows-hook-peer'
import type { HookResumeIntent } from '../../../shared/agent-hook-listener/state/hook-resume-intent'
import {
  captureHookLaunchContext,
  type HookLaunchContext
} from '../../agent-hooks/hook-launch-context'

// Why a side table: only the listing reads it, and Session is at its max-lines cap.
const spawnPaneKeys = new WeakMap<Session, string>()
const hookContexts = new WeakMap<Session, HookLaunchContext>()

export function getSessionHookResumeIntent(session: Session): HookResumeIntent | null | undefined {
  return hookContexts.get(session)?.resumeIntent
}

/** Records the ORCA_PANE_KEY a session was spawned with; reattaching never rewrites it. */
export function recordSessionSpawnPaneKey(
  session: Session,
  paneKey: string | undefined,
  env?: Readonly<Record<string, string>>,
  cwd?: string,
  resumeIntent?: HookResumeIntent | null
): void {
  if (paneKey) {
    spawnPaneKeys.set(session, paneKey)
  }
  if (!hookContexts.has(session) && cwd) {
    const context = captureHookLaunchContext(
      env,
      cwd,
      readWindowsProcessCreationKey(session.pid),
      resumeIntent
    )
    if (context) {
      hookContexts.set(session, context)
    }
  }
}

const wslGuestRoots = new WeakMap<Session, WslGuestRoot>()

/** A WSL session's guest root shell, as its own launch output reported it. */
export function recordSessionWslGuestRoot(session: Session, root: WslGuestRoot): void {
  wslGuestRoots.set(session, root)
}

export function listLiveTerminalHostSessions(
  sessions: ReadonlyMap<string, Session>,
  agentSessionOwners: ClaimedAgentPtyOwnerRegistry
): SessionInfo[] {
  const result: SessionInfo[] = []
  for (const session of sessions.values()) {
    if (!session.isAlive) {
      continue
    }
    const size = session.getAppliedSize()
    const paneKey = spawnPaneKeys.get(session)
    const hookContext = hookContexts.get(session)
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
