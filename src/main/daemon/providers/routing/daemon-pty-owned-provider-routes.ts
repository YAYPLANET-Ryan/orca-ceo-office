import type { DaemonPtyAdapter } from '../adapter/daemon-pty-adapter'
import type { HookProviderObservationUpdate } from '../../../../shared/agent-hook-listener/state/hook-provider-observation'

export abstract class DaemonPtyOwnedProviderRoutes {
  protected current: DaemonPtyAdapter
  protected legacy: DaemonPtyAdapter[]
  protected readonly sessionAdapters = new Map<string, DaemonPtyAdapter>()

  protected constructor(opts: { current: DaemonPtyAdapter; legacy: DaemonPtyAdapter[] }) {
    this.current = opts.current
    this.legacy = opts.legacy
  }

  async recordHookProviderObservation(update: HookProviderObservationUpdate) {
    const adapter = this.sessionAdapters.get(update.ptyId)
    if (!adapter) {
      throw new Error('hook_provider_observation_route_unavailable')
    }
    const observation = await adapter.recordHookProviderObservation(update)
    if (this.sessionAdapters.get(update.ptyId) !== adapter) {
      throw new Error('hook_provider_observation_route_changed')
    }
    return observation
  }
}
