import { toast } from 'sonner'
import type { TerminalLaunchResult } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import { RESUME_CHECKPOINT_WARNING } from '../../../../../shared/agent-session/lifecycle/resume-checkpoint-warning'

export function notifyResumeCheckpointFailure(
  result: TerminalLaunchResult | null,
  ptyId: string | null
): void {
  if (result?.resumeCheckpointFailed) {
    toast.warning(RESUME_CHECKPOINT_WARNING, { id: `resume-checkpoint-${ptyId}` })
  }
}
