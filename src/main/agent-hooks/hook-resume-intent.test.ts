import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import {
  hookResumeIntentFromLaunch,
  readHookResumeIntent
} from '../../shared/agent-hook-listener/state/hook-resume-intent'
import { captureHookLaunchContext, readHookLaunchContext } from './hook-launch-context'
import { sameHookContextSnapshot } from './server/hook-context-snapshot'

const cwd = resolve('synthetic-workspace')
const env = { ORCA_AGENT_HOOK_OWNER: 'a'.repeat(64), ORCA_AGENT_LAUNCH_TOKEN: 'abc' }
const intent = { agentType: 'codex' as const, providerSessionId: 'original-conversation' }

describe('host-owned resume intent transport', () => {
  it.each(['claude', 'codex'])(
    'retains the exact structured %s request independently of env',
    (agent) => {
      const declared = hookResumeIntentFromLaunch(agent, {
        key: 'session_id',
        id: 'original-conversation'
      })
      const context = captureHookLaunchContext(env, cwd, undefined, declared)
      expect(readHookLaunchContext(JSON.parse(JSON.stringify(context)))?.resumeIntent).toEqual({
        agentType: agent,
        providerSessionId: 'original-conversation'
      })
    }
  )

  it('keeps missing legacy intent distinct from a structured fresh request', () => {
    const legacy = captureHookLaunchContext(env, cwd)
    const fresh = captureHookLaunchContext(env, cwd, undefined, null)
    expect(readHookLaunchContext(JSON.parse(JSON.stringify(legacy)))?.resumeIntent).toBeUndefined()
    expect(readHookLaunchContext(JSON.parse(JSON.stringify(fresh)))?.resumeIntent).toBeNull()
    expect(hookResumeIntentFromLaunch(undefined, undefined)).toBeUndefined()
    expect(hookResumeIntentFromLaunch('codex', undefined)).toBeUndefined()
    expect(hookResumeIntentFromLaunch('codex', null)).toBeUndefined()
  })

  it('does not let caller env introduce a resume intent', () => {
    const context = captureHookLaunchContext(
      {
        ...env,
        ORCA_AGENT_RESUME_INTENT: JSON.stringify(intent),
        resumeIntent: JSON.stringify(intent)
      },
      cwd
    )
    expect(context?.resumeIntent).toBeUndefined()
  })

  it('copies the typed declaration so later request mutation cannot rewrite the captured intent', () => {
    const mutable = { ...intent }
    const context = captureHookLaunchContext(env, cwd, undefined, mutable)
    mutable.providerSessionId = 'other-conversation'
    expect(context?.resumeIntent?.providerSessionId).toBe('original-conversation')
  })

  it.each([
    { ...intent, providerSessionId: ' original-conversation' },
    { ...intent, providerSessionId: 'bad\0id' },
    { ...intent, providerSessionId: '' },
    { ...intent, providerSessionId: 'x'.repeat(2049) },
    { ...intent, agentType: 'other' },
    { ...intent, command: 'synthetic-private-command' }
  ])('rejects malformed intent as a whole context instead of dropping it to fresh', (malformed) => {
    const context = captureHookLaunchContext(env, cwd)
    expect(readHookResumeIntent(malformed)).toBeUndefined()
    expect(readHookLaunchContext({ ...context, resumeIntent: malformed })).toBeUndefined()
  })

  it('does not silently normalize a requested conversation ID', () => {
    expect(
      hookResumeIntentFromLaunch('codex', { key: 'session_id', id: ' original-conversation ' })
    ).toBeUndefined()
    expect(
      hookResumeIntentFromLaunch('codex', { key: 'unknown', id: 'original-conversation' })
    ).toBeUndefined()
  })

  it('detects intent changes during a context verification even if all process metadata stays equal', () => {
    const snapshot = {
      executionHostId: 'local' as const,
      paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
      worktreeId: 'workspace-a',
      ptyId: 'pty-a',
      incarnationId: 'generation-a',
      launchTokenHash: 'a'.repeat(64),
      cwd,
      reportedCwd: cwd,
      resumeIntent: intent
    }
    expect(sameHookContextSnapshot(snapshot, { ...snapshot, resumeIntent: { ...intent } })).toBe(
      true
    )
    expect(sameHookContextSnapshot(snapshot, { ...snapshot, resumeIntent: undefined })).toBe(false)
    expect(sameHookContextSnapshot(snapshot, { ...snapshot, resumeIntent: null })).toBe(false)
    expect(
      sameHookContextSnapshot(snapshot, {
        ...snapshot,
        resumeIntent: { ...intent, providerSessionId: 'other-conversation' }
      })
    ).toBe(false)
  })
})
