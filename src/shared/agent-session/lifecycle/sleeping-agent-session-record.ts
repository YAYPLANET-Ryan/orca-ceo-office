import type { AgentStatusState } from '../../agent-status/contracts/agent-status-types'
import type { AgentMainAgentStatus } from '../../agent-status/lifecycle/main-agent-status'
import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SleepingAgentLaunchConfig
} from './agent-session-resume'
import type { LegacyPaneResumeMetadata } from './legacy-pane-resume-metadata'

export type SleepingAgentSessionRecord = LegacyPaneResumeMetadata & {
  paneKey: string
  tabId?: string
  worktreeId: string
  agent: ResumableTuiAgent
  providerSession: AgentProviderSessionMetadata
  prompt: string
  state: AgentStatusState
  capturedAt: number
  updatedAt: number
  terminalTitle?: string
  lastAssistantMessage?: string
  interrupted?: boolean
  /** The main agent's own status when captured, copied with `interrupted` by `agentVerdictFields`;
   *  read the verdict through `agentMainAgentVerdict`. */
  mainAgent?: AgentMainAgentStatus
  connectionId?: string | null
  launchConfig?: SleepingAgentLaunchConfig
  /** Worktree-sleep/legacy records open fresh tabs on activation. quit/live records belong to restored panes; only their cold-restore path consumes them to avoid duplicating warm sessions (#5232). */
  origin?: 'worktree-sleep' | 'quit' | 'live'
  /** Explicit-sleep finished panes resume only when their own tab opens; mobile wake must not mount/respawn every slept tab (#11598). */
  restoreOnTabOpenOnly?: boolean
}
