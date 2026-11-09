import { DaemonPtySessionInput } from './daemon-pty-session-input'
import { HOOK_PROVIDER_OBSERVATION_PROTOCOL_VERSION } from '../../protocol/daemon-protocol-version'
import type { RecordHookProviderObservationResult } from '../../protocol/daemon-hook-provider-observation-protocol'
import {
  readHookProviderObservation,
  type HookProviderObservationUpdate
} from '../../../../shared/agent-hook-listener/state/hook-provider-observation'

export abstract class DaemonPtyProviderObservation extends DaemonPtySessionInput {
  async recordHookProviderObservation(update: HookProviderObservationUpdate) {
    if (this.protocolVersion < HOOK_PROVIDER_OBSERVATION_PROTOCOL_VERSION) {
      return null
    }
    await this.ensureConnected()
    const result = await this.client.request<RecordHookProviderObservationResult>(
      'recordHookProviderObservation',
      update
    )
    const observation = readHookProviderObservation(result.observation)
    if (
      !observation ||
      observation.ptyId !== update.ptyId ||
      observation.incarnationId !== update.incarnationId ||
      observation.paneKey !== update.paneKey ||
      observation.worktreeId !== update.worktreeId ||
      observation.ownerClientInstanceId !== update.ownerClientInstanceId ||
      observation.launchTokenHash !== update.launchTokenHash ||
      observation.launchCwd !== update.launchCwd ||
      observation.cwd !== update.cwd ||
      observation.agentType !== update.agentType ||
      observation.providerSessionId !== update.providerSessionId
    ) {
      throw new Error('hook_provider_observation_response_unconfirmed')
    }
    return observation
  }
}
