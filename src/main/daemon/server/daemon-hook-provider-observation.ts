import {
  readHookProviderObservationUpdate,
  type HookProviderObservationUpdate
} from '../../../shared/agent-hook-listener/state/hook-provider-observation'
import type { DaemonClientConnections } from './daemon-client-connections'
import type { DaemonSessionAttachments } from './daemon-session-attachments'
import type { TerminalHost } from '../terminal-host/terminal-host'

export async function recordDaemonProviderObservation(
  clientId: string,
  update: HookProviderObservationUpdate,
  options: {
    connections: DaemonClientConnections
    attachments: DaemonSessionAttachments
    host: TerminalHost
  }
) {
  const selected = readHookProviderObservationUpdate(update)
  if (!selected) {
    throw new Error('invalid_hook_provider_observation')
  }
  const client = options.connections.get(clientId)
  const attachment = options.attachments.tokenForSessionClient(selected.ptyId, clientId)
  if (!client?.authenticatedPairEstablished || client.streamSocket === null || !attachment) {
    throw new Error('hook_provider_observation_not_owner')
  }
  const observation = await options.host.recordProviderObservation(selected, attachment)
  return { observation }
}
