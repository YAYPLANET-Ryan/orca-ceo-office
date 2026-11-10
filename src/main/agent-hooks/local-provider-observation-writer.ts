import { realpath } from 'node:fs/promises'
import { normalize } from 'node:path'
import type { LocalPtyInventoryReader } from './observations/local-tmux-managed-pty'
import type { IPtyProvider } from '../providers/pty-provider-contract'
import type { ProviderObservationWriter } from './server/provider-observation-queue'
import { matchesProviderObservationScope } from './server/provider-observation-scope'
import { readHookProviderObservation } from '../../shared/agent-hook-listener/state/hook-provider-observation'

/** Resolve only the established local route, never create a PTY or infer authority from a journal. */
export function createLocalProviderObservationWriter(
  readInventory: LocalPtyInventoryReader,
  getProvider: () => IPtyProvider
): ProviderObservationWriter {
  return async (update) => {
    const provider = getProvider()
    const row = await readInventory(update.paneKey, { bySpawnPaneKey: true, fresh: true })
    if (
      !row ||
      row.exiting ||
      row.routed === false ||
      row.wslDistro ||
      row.ownerClientAttached !== true ||
      row.paneBound !== true ||
      row.id !== update.ptyId ||
      row.incarnationId !== update.incarnationId ||
      row.paneKey !== update.paneKey ||
      row.worktreeId !== update.worktreeId ||
      row.ownerClientInstanceId !== update.ownerClientInstanceId ||
      row.launchTokenHash !== update.launchTokenHash ||
      row.contextCwd !== update.launchCwd ||
      /^(?:\\\\|\/\/)/.test(row.contextCwd)
    ) {
      throw new Error('hook_provider_observation_current_owner_unconfirmed')
    }
    const cwd = normalize(await realpath(row.contextCwd))
    if (cwd !== update.cwd || /^(?:\\\\|\/\/)/.test(cwd) || getProvider() !== provider) {
      throw new Error('hook_provider_observation_current_scope_changed')
    }
    const current = readHookProviderObservation(row.providerObservation)
    if (current && !matchesProviderObservationScope(current, update)) {
      throw new Error('hook_provider_observation_current_scope_unconfirmed')
    }
    // Only an already identical observation may use its acknowledged revision.
    // Still call the host so a client transfer during realpath cannot fake an ack.
    const identical =
      current?.agentType === update.agentType &&
      current.providerSessionId === update.providerSessionId
    if (!identical && (current?.revision ?? 0) !== update.expectedRevision) {
      throw new Error('hook_provider_observation_current_revision_changed')
    }
    if (!provider.recordHookProviderObservation) {
      return null
    }
    const receipt = await provider.recordHookProviderObservation({
      ...update,
      expectedRevision: identical ? current.revision : update.expectedRevision
    })
    if (getProvider() !== provider) {
      throw new Error('hook_provider_observation_current_route_changed')
    }
    return receipt
  }
}
