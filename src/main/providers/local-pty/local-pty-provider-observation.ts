import { realpath } from 'node:fs/promises'
import { normalize } from 'node:path'
import type { IPty } from 'node-pty'
import { launchTokenHash } from '../../../shared/agent-hook-listener/transport/agent-hook-spool'
import { advanceHookProviderObservation } from '../../../shared/agent-hook-listener/state/hook-provider-observation-transition'
import {
  readHookProviderObservationUpdate,
  type HookProviderObservation,
  type HookProviderObservationUpdate
} from '../../../shared/agent-hook-listener/state/hook-provider-observation'
import {
  ptyProcesses,
  ptyHookContexts,
  ptyIncarnations,
  ptySpawnPaneKeys,
  ptyWorktreeId,
  ptyWslDistroById,
  ptyShutdownOperations
} from './local-pty-provider-state'

const observations = new WeakMap<IPty, HookProviderObservation>()
const launchAgents = new WeakMap<IPty, string | null>()

export function recordLocalProviderObservationLaunch(proc: IPty, agent: string | null): void {
  if (!launchAgents.has(proc) && (agent === null || typeof agent === 'string')) {
    launchAgents.set(proc, agent)
  }
}

export function getLocalProviderObservation(id: string): HookProviderObservation | undefined {
  const proc = ptyProcesses.get(id)
  return proc ? observations.get(proc) : undefined
}

export function getLocalPtyCurrentResumeIntent(id: string) {
  const observation = getLocalProviderObservation(id)
  return observation
    ? { agentType: observation.agentType, providerSessionId: observation.providerSessionId }
    : ptyHookContexts.get(id)?.resumeIntent
}

export async function recordLocalProviderObservation(
  rawUpdate: HookProviderObservationUpdate
): Promise<HookProviderObservation> {
  const update = readHookProviderObservationUpdate(rawUpdate)
  if (!update) {
    throw new Error('invalid_hook_provider_observation')
  }
  const id = update.ptyId
  const proc = ptyProcesses.get(id)
  const context = ptyHookContexts.get(id)
  const incarnationId = ptyIncarnations.get(id)
  const paneKey = ptySpawnPaneKeys.get(id)
  const worktreeId = ptyWorktreeId.get(id)
  if (
    !proc ||
    !context ||
    !incarnationId ||
    !paneKey ||
    !worktreeId ||
    !launchAgents.has(proc) ||
    ptyShutdownOperations.has(id) ||
    ptyWslDistroById.get(id) ||
    (process.platform === 'win32' && ptyWslDistroById.get(id) !== null) ||
    incarnationId !== update.incarnationId ||
    paneKey !== update.paneKey ||
    worktreeId !== update.worktreeId ||
    context.ownerClientInstanceId !== update.ownerClientInstanceId ||
    context.launchTokenHash !== update.launchTokenHash ||
    context.cwd !== update.launchCwd ||
    launchTokenHash(update.launchToken) !== context.launchTokenHash ||
    /^(?:\\\\|\/\/)/.test(context.cwd)
  ) {
    throw new Error('hook_provider_observation_scope_unconfirmed')
  }
  const cwd = normalize(await realpath(context.cwd))
  if (
    ptyProcesses.get(id) !== proc ||
    ptyHookContexts.get(id) !== context ||
    ptyIncarnations.get(id) !== incarnationId ||
    ptySpawnPaneKeys.get(id) !== paneKey ||
    ptyWorktreeId.get(id) !== worktreeId ||
    ptyShutdownOperations.has(id) ||
    ptyWslDistroById.get(id) ||
    (process.platform === 'win32' && ptyWslDistroById.get(id) !== null) ||
    /^(?:\\\\|\/\/)/.test(cwd) ||
    cwd !== update.cwd
  ) {
    throw new Error('hook_provider_observation_scope_changed')
  }
  const observation = advanceHookProviderObservation(observations.get(proc), update, {
    scope: {
      ptyId: id,
      incarnationId,
      paneKey,
      worktreeId,
      ownerClientInstanceId: context.ownerClientInstanceId,
      launchTokenHash: context.launchTokenHash,
      launchCwd: context.cwd,
      cwd
    },
    launchAgent: launchAgents.get(proc) ?? null,
    resumeIntent: context.resumeIntent
  })
  observations.set(proc, observation)
  return observation
}
