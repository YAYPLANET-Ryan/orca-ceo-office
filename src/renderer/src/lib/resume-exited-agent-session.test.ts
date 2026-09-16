import { afterEach, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialState = useAppStore.getState()
afterEach(() => useAppStore.setState(initialState, true))

it.each(['working', 'done'] as const)(
  'preserves a confirmed %s exit without activation relaunch',
  (state) => {
    const record: SleepingAgentSessionRecord = {
      paneKey: 'tab:leaf',
      tabId: 'tab',
      worktreeId: 'wt',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'test-session' },
      prompt: '',
      state,
      capturedAt: 1,
      updatedAt: 1,
      origin: 'live',
      requiresManualResume: true
    }
    useAppStore.setState({
      tabsByWorktree: {},
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    })
    expect(resumeSleepingAgentSessionsForWorktree('wt')).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
    expect(useAppStore.getState().tabsByWorktree).toEqual({})
  }
)
