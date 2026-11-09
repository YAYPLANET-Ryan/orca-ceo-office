import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { HookResumeIntent } from '../../../../shared/agent-hook-listener/state/hook-resume-intent'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../shared/agent-session/lifecycle/agent-session-resume'

export type ResumeSpawnArgs = {
  hookResumeIntent?: HookResumeIntent | null
  connectionId?: string | null
  command?: string
  launchAgent?: TuiAgent
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: unknown
  resumeProviderSession?: AgentProviderSessionMetadata
  /** The pane's saved facts, rather than an explicit user resume request. */
  resumeOrigin?: unknown
  env?: Record<string, string>
}
