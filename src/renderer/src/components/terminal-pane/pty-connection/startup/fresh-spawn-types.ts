import type {
  AgentProviderSessionMetadata,
  ResumableTuiAgent,
  SavedResumeStartupSource,
  SleepingAgentSessionRecord
} from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { buildAgentResumeStartupPlan } from '../../../../../../shared/agent-launch/startup/tui-agent-resume-startup'

export type PendingStartupCommand = {
  command: string
  resumeSource?: SavedResumeStartupSource
  isCurrent?: () => boolean
  env?: Record<string, string>
}

export type FreshSpawnOptions = {
  forceBlankRestoredViewport?: boolean
  /** Main started the pane without resuming the requested agent session. */
  onAgentResumeUnavailable?: () => void
  /** false: start a plain shell instead of the pane's own launch. */
  inheritStartupCommand?: false
}

export type ColdRestoreAgentResumeStartup = PendingStartupCommand & {
  agent: ResumableTuiAgent
  resumeProviderSession: AgentProviderSessionMetadata
  connectionId?: string | null
  /** Built from the pane's saved facts, so the host refuses it for a chat's conversation. */
  resumeOrigin: 'saved'
  launchConfig: NonNullable<ReturnType<typeof buildAgentResumeStartupPlan>>['launchConfig']
  launchToken: string
  useLiveEntry: boolean
  hasSleepingRecord: boolean
  sleepingRecordEntry: { paneKey: string; record: SleepingAgentSessionRecord } | null
}

/** The connect's startup fields: the startup's own command and env, or a plain shell when the launch must not replay. */
export function freshSpawnCommandFields(
  startup: PendingStartupCommand | null | undefined,
  options: FreshSpawnOptions,
  mergeEnv: (env: Record<string, string>) => Record<string, string> | undefined
): { command?: string; env?: Record<string, string>; inheritStartupCommand?: false } {
  const env = startup?.env ? mergeEnv(startup.env) : undefined
  return {
    ...(startup?.command ? { command: startup.command } : {}),
    ...(env ? { env } : {}),
    ...(options.inheritStartupCommand === false ? { inheritStartupCommand: false as const } : {})
  }
}
