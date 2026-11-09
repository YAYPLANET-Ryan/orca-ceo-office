import { expect, it } from 'vitest'
import { suppressSavedResumeLaunch } from './saved-resume-admission'
import type { ResumeSpawnArgs } from './saved-resume-launch-args'

it('does not leave an original resume intent on the plain shell after saved launch refusal', () => {
  const intent = { agentType: 'codex' as const, providerSessionId: 'original-conversation' }
  const args: ResumeSpawnArgs = {
    launchAgent: 'codex',
    command: 'codex resume original-conversation',
    hookResumeIntent: intent,
    resumeProviderSession: { key: 'session_id', id: 'original-conversation' }
  }
  const options = { ...args, env: { UNRELATED: 'retained' } }
  suppressSavedResumeLaunch(args, options)
  expect(args.hookResumeIntent).toBeUndefined()
  expect(options.hookResumeIntent).toBeUndefined()
  expect(options.command).toBeUndefined()
  expect(options.env).toEqual({ UNRELATED: 'retained' })
  expect(intent.providerSessionId).toBe('original-conversation')
})
