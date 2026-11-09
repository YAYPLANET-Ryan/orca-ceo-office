import type { Session } from '../sessions/session'
import { readWindowsProcessCreationKey } from '../../windows/windows-hook-peer'
import type { HookResumeIntent } from '../../../shared/agent-hook-listener/state/hook-resume-intent'
import {
  captureHookLaunchContext,
  type HookLaunchContext
} from '../../agent-hooks/hook-launch-context'

const recorded = new WeakSet<Session>()
const spawnPaneKeys = new WeakMap<Session, string>()
const hookContexts = new WeakMap<Session, HookLaunchContext>()

export function getSessionHookContext(session: Session) {
  return { context: hookContexts.get(session), paneKey: spawnPaneKeys.get(session) }
}

/** An unavailable first capture cannot be retroactively attested on reattach. */
export function recordSessionSpawnPaneKey(
  session: Session,
  paneKey: string | undefined,
  env?: Readonly<Record<string, string>>,
  cwd?: string,
  resumeIntent?: HookResumeIntent | null
): void {
  if (recorded.has(session)) {
    return
  }
  recorded.add(session)
  if (paneKey) {
    spawnPaneKeys.set(session, paneKey)
  }
  if (cwd) {
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
