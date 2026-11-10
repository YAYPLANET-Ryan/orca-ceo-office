import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from './agent-session-resume'
import { capturedResumeRecord, liveResumeRecordChange } from './agent-resume-record-from-status'
import { exitFenceHolds } from './agent-resume-exit-fence'

function record(overrides: Partial<SleepingAgentSessionRecord> = {}): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'build it',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'live',
    ...overrides
  }
}

// capturedAt is the exit time.
const exited = record({ requiresManualResume: true, capturedAt: 10, updatedAt: 5 })

describe('exited conversation resume fence', () => {
  it('keeps the saved record when the pane reports no resumable status', () => {
    expect(liveResumeRecordChange(exited, null)).toBeNull()
    expect(liveResumeRecordChange(record(), null)).toBe('clear')
  })

  it('keeps the fence through a late completion of the same conversation', () => {
    const late = record({ state: 'done', prompt: '', updatedAt: 12, capturedAt: 12 })
    expect(liveResumeRecordChange(exited, late)).toEqual({
      set: { ...late, capturedAt: 12, requiresManualResume: true }
    })
    const earlier = record({ state: 'done', prompt: '', updatedAt: 4, capturedAt: 4 })
    expect(liveResumeRecordChange(exited, earlier)).toEqual({
      set: { ...earlier, capturedAt: 10, requiresManualResume: true }
    })
  })

  it('lifts the fence once the same conversation runs again', () => {
    const resumed = record({ state: 'working', updatedAt: 11 })
    expect(liveResumeRecordChange(exited, resumed)).toEqual({ set: resumed })
  })

  it('lets a different conversation in the pane replace the exited one', () => {
    const next = record({ state: 'done', providerSession: { key: 'session_id', id: 'sess-2' } })
    expect(liveResumeRecordChange(exited, next)).toEqual({ set: next })
  })

  it('a stale running row from before the exit does not lift the fence', () => {
    expect(liveResumeRecordChange(exited, record({ state: 'working', updatedAt: 9 }))).toBeNull()
  })

  it('quit capture keeps the fenced record over a stale running row', () => {
    const captureFrom = (updatedAt: number) =>
      capturedResumeRecord({
        entry: {
          paneKey: exited.paneKey,
          agentType: 'codex',
          state: 'working',
          prompt: 'build it',
          updatedAt,
          providerSession: exited.providerSession
        },
        existing: exited,
        mode: 'quit',
        capturedAt: 20,
        worktreeIdOf: () => 'wt-1',
        tabOf: () => ({ id: 'tab-1' }),
        launchConfigOf: () => undefined
      })
    expect(captureFrom(9)).toBeNull()
    expect(captureFrom(11)).toMatchObject({ origin: 'quit', state: 'working' })
    expect(captureFrom(11)?.requiresManualResume).toBeUndefined()
  })

  it('the exit fence holds only for the same session up to the exit time', () => {
    const status = { agentType: 'codex', providerSession: exited.providerSession, updatedAt: 10 }
    expect(exitFenceHolds(exited, status)).toBe(true)
    expect(exitFenceHolds(exited, { ...status, updatedAt: 11 })).toBe(false)
    expect(exitFenceHolds(exited, { ...status, agentType: 'claude' })).toBe(false)
    expect(
      exitFenceHolds(exited, { ...status, providerSession: { key: 'session_id', id: 'other' } })
    ).toBe(false)
    expect(exitFenceHolds(record(), status)).toBe(false)
  })
})
