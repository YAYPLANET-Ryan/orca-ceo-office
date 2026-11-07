import { describe, expect, it } from 'vitest'
import { resolveCodexResumeLaunch } from './codex-resume'
import type { CodexSessionResumePreparation } from '../../../codex/history/resume/codex-session-resume-home'

const providerSession = { key: 'session_id' as const, id: 'required-original-session' }
const command = "codex resume 'required-original-session'"

describe('requested Codex conversation identity', () => {
  it.each<CodexSessionResumePreparation | null>([
    null,
    { outcome: 'fresh', claimedCodexProvenance: false },
    { outcome: 'fresh', claimedCodexProvenance: true }
  ])(
    'refuses a fresh conversation when requested identity cannot be verified: %j',
    async (result) => {
      await expect(
        resolveCodexResumeLaunch(command, {
          providerSession,
          preparation: Promise.resolve(result)
        })
      ).rejects.toThrow(
        'Orca could not verify the originating Codex session file, so automatic resume was stopped to avoid using a different account.'
      )
    }
  )

  it('launches the original conversation when resume provenance is verified', async () => {
    await expect(
      resolveCodexResumeLaunch(command, {
        providerSession,
        preparation: Promise.resolve({
          outcome: 'resume',
          codexHomePath: '/hermetic-origin-home'
        })
      })
    ).resolves.toEqual({
      command: "codex resume 'required-original-session'",
      codexResumeHome: { outcome: 'resume', codexHomePath: '/hermetic-origin-home' },
      providerSession: { key: 'session_id', id: 'required-original-session' },
      droppedResumeArgv: false,
      notifyResumeUnavailable: false
    })
  })
})
