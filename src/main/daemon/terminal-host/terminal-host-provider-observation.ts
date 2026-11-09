import { realpath } from 'node:fs/promises'
import { normalize } from 'node:path'
import { launchTokenHash } from '../../../shared/agent-hook-listener/transport/agent-hook-spool'
import type { Session } from '../sessions/session'
import { getSessionHookContext } from './terminal-host-hook-context'
import {
  readHookProviderObservationUpdate,
  type HookProviderObservation,
  type HookProviderObservationUpdate
} from '../../../shared/agent-hook-listener/state/hook-provider-observation'
import { parsePtySessionId } from '../../../shared/terminal/pty/lifecycle/pty-session-id-format'
import { advanceHookProviderObservation } from '../../../shared/agent-hook-listener/state/hook-provider-observation-transition'

const observations = new WeakMap<Session, HookProviderObservation>()

export function getSessionProviderObservation(
  session: Session
): HookProviderObservation | undefined {
  return observations.get(session)
}

export async function recordSessionProviderObservation(
  session: Session,
  attachment: symbol,
  rawUpdate: HookProviderObservationUpdate
): Promise<HookProviderObservation> {
  const update = readHookProviderObservationUpdate(rawUpdate)
  if (!update) {
    throw new Error('invalid_hook_provider_observation')
  }
  const initial = getSessionHookContext(session)
  const context = initial.context
  const worktreeId = parsePtySessionId(session.sessionId).worktreeId
  if (
    !context ||
    !worktreeId ||
    session.wslDistro !== null ||
    !session.isAlive ||
    session.isTerminating ||
    !session.hasAttachedClient(attachment) ||
    session.sessionId !== update.ptyId ||
    session.incarnationId !== update.incarnationId ||
    initial.paneKey !== update.paneKey ||
    worktreeId !== update.worktreeId ||
    context.ownerClientInstanceId !== update.ownerClientInstanceId ||
    context.launchTokenHash !== update.launchTokenHash ||
    context.cwd !== update.launchCwd ||
    launchTokenHash(update.launchToken) !== context.launchTokenHash ||
    /^(?:\\\\|\/\/)/.test(context.cwd) ||
    (session.launchAgent !== null && session.launchAgent !== update.agentType) ||
    (context.resumeIntent && context.resumeIntent.agentType !== update.agentType)
  ) {
    throw new Error('hook_provider_observation_scope_unconfirmed')
  }
  const cwd = normalize(await realpath(context.cwd))
  if (
    !session.isAlive ||
    session.isTerminating ||
    !session.hasAttachedClient(attachment) ||
    getSessionHookContext(session).context !== context ||
    getSessionHookContext(session).paneKey !== initial.paneKey ||
    /^(?:\\\\|\/\/)/.test(cwd) ||
    cwd !== update.cwd
  ) {
    throw new Error('hook_provider_observation_scope_changed')
  }
  const observation = advanceHookProviderObservation(observations.get(session), update, {
    scope: {
      ptyId: session.sessionId,
      incarnationId: session.incarnationId,
      paneKey: initial.paneKey,
      worktreeId,
      ownerClientInstanceId: context.ownerClientInstanceId,
      launchTokenHash: context.launchTokenHash,
      launchCwd: context.cwd,
      cwd
    },
    launchAgent: session.launchAgent,
    resumeIntent: context.resumeIntent
  })
  observations.set(session, observation)
  return observation
}
