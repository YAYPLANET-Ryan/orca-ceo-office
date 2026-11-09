import { AgentHookServerState } from './server-state'
import type { ResumeLaunchRecipeJournal } from './resume-launch-recipe-journal'

export abstract class AgentHookServerResumeRecipeState extends AgentHookServerState {
  protected resumeRecipeJournal?: ResumeLaunchRecipeJournal
  protected resumeRecipeJournalBindingValid = false
  protected resumeRecipePersistenceFailing = false
}
