import type { AgentSessionOwnerBinding } from '../../../shared/agent-session/agent-session-host-authority'
import type { SessionState, ShellReadyState } from './daemon-rpc-contract'
import type { WslGuestRoot } from '../../../shared/wsl-guest-root-marker'
import type { HookLaunchContext } from '../../agent-hooks/hook-launch-context'
import type { HookProviderObservation } from '../../../shared/agent-hook-listener/state/hook-provider-observation'

export type SessionInfo = {
  foregroundProcess?: string
  sessionId: string
  incarnationId?: string
  state: SessionState
  shellState: ShellReadyState
  isAlive: boolean
  terminalHandle?: string
  /** ORCA_PANE_KEY the PTY was spawned with; absent from daemons that predate it. */
  paneKey?: string
  hookContext?: HookLaunchContext
  providerObservation?: HookProviderObservation
  attachedToRequester?: boolean
  wslDistro?: string | null
  /** Seen once in a WSL session's launch output; volatile metadata of this incarnation. */
  wslGuestRoot?: WslGuestRoot
  pid: number | null
  cwd: string | null
  cols: number
  rows: number
  createdAt: number
  agentSessionOwners?: AgentSessionOwnerBinding[]
}

/** Router/adapter metadata for legacy-session labels; never transmitted on the daemon wire. */
export type DaemonSessionInfo = SessionInfo & {
  protocolVersion: number
}
