import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from './agent-session-resume'
import { liveResumeRecordChange } from './agent-resume-record-from-status'

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

const exited = record({ requiresManualResume: true })

describe('exited conversation resume fence', () => {
  it('keeps the saved record when the pane reports no resumable status', () => {
    expect(liveResumeRecordChange(exited, null)).toBeNull()
    expect(liveResumeRecordChange(record(), null)).toBe('clear')
  })

  it('keeps the fence through a late completion of the same conversation', () => {
    const late = record({ state: 'done', prompt: '', updatedAt: 2 })
    expect(liveResumeRecordChange(exited, late)).toEqual({
      set: { ...late, requiresManualResume: true }
    })
  })

  it('lifts the fence once the same conversation runs again', () => {
    const resumed = record({ state: 'working', updatedAt: 3 })
    expect(liveResumeRecordChange(exited, resumed)).toEqual({ set: resumed })
  })

  it('lets a different conversation in the pane replace the exited one', () => {
    const next = record({ state: 'done', providerSession: { key: 'session_id', id: 'sess-2' } })
    expect(liveResumeRecordChange(exited, next)).toEqual({ set: next })
  })
})
