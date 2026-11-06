import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../shared/agent-status-types'
import { parseWorkspaceSession } from '../../../shared/workspace-session-schema'
import { buildWorkspaceSessionPayload } from './workspace-session'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'
import { pendingConversationRecoveries } from './pending-conversation-recovery'

const initial = useAppStore.getState()
const worktreeId = FLOATING_TERMINAL_WORKTREE_ID
afterEach(() => useAppStore.setState(initial, true))
function seed(): SleepingAgentSessionRecord {
  const record: SleepingAgentSessionRecord = {
    paneKey: 'old:leaf',
    tabId: 'old',
    worktreeId,
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'synthetic-conversation' },
    prompt: 'saved request',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'quit'
  }
  useAppStore.setState(
    {
      ...initial,
      activeWorktreeId: worktreeId,
      tabsByWorktree: { [worktreeId]: [] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    },
    true
  )
  return record
}
function launch() {
  const record = seed()
  expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(1)
  const state = useAppStore.getState()
  const target = state.sleepingAgentSessionsByPaneKey[record.paneKey]!.resumeTargetPaneKey!
  return { record, target, tab: state.tabsByWorktree[worktreeId]![0]! }
}

describe('durable recovery retention', () => {
  it('keeps a real quit capture whose previous status is older than 30 minutes', () => {
    const record = seed()
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {},
      agentStatusByPaneKey: {
        [record.paneKey]: {
          paneKey: record.paneKey,
          worktreeId,
          agentType: record.agent,
          providerSession: record.providerSession,
          state: 'working',
          prompt: record.prompt,
          updatedAt: Date.now() - AGENT_STATUS_STALE_AFTER_MS - 1000,
          stateStartedAt: 1,
          stateHistory: []
        }
      }
    })
    useAppStore.getState().captureAllSleepingAgentSessions('quit')
    useAppStore.setState({ agentStatusByPaneKey: {} })
    resumeSleepingAgentSessionsForWorktree(worktreeId)
    expect(
      useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]?.providerSession
    ).toEqual(record.providerSession)
  })

  it('publishes destination identity atomically with the new tab', () => {
    const record = seed()
    const invalidSnapshots: number[] = []
    const unsubscribe = useAppStore.subscribe((state) => {
      for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
        const target = state.sleepingAgentSessionsByPaneKey[record.paneKey]?.resumeTargetPaneKey
        if (!target || !state.sleepingAgentSessionsByPaneKey[target]) {
          invalidSnapshots.push(1)
        }
        expect(state.terminalLayoutsByTabId[tab.id]?.root?.type).toBe('leaf')
      }
    })
    try {
      resumeSleepingAgentSessionsForWorktree(worktreeId)
    } finally {
      unsubscribe()
    }
    expect(invalidSnapshots).toEqual([])
  })

  it('round trips pending recovery through the real session schema and hydration without another tab', () => {
    const { record, target, tab } = launch()
    useAppStore.getState().consumeTabStartupCommand(tab.id)
    const parsed = parseWorkspaceSession(
      JSON.parse(JSON.stringify(buildWorkspaceSessionPayload(useAppStore.getState())))
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      throw new Error(parsed.error)
    }
    useAppStore.setState(initial, true)
    useAppStore.getState().hydrateWorkspaceSession(parsed.value)
    expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(0)
    const state = useAppStore.getState()
    expect(state.tabsByWorktree[worktreeId]).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[target]).toMatchObject({
      providerSession: record.providerSession,
      requiresManualResume: true
    })
    expect(state.automaticAgentResumeClaimsByTabId).toEqual({})
  })

  it('does not advertise success when only startup was queued', () => {
    const { tab } = launch()
    expect(useAppStore.getState().pendingStartupByTabId[tab.id]?.showSessionRestoredBanner).toBe(
      false
    )
  })

  it('persists the resolved model configuration when the older record had no launch settings', () => {
    const record = seed()
    useAppStore.setState({
      settings: {
        agentCmdOverrides: {},
        agentDefaultArgs: { codex: '--model synthetic-recovery-model' },
        agentDefaultEnv: {}
      }
    } as never)
    resumeSleepingAgentSessionsForWorktree(worktreeId)
    const state = useAppStore.getState()
    const target = state.sleepingAgentSessionsByPaneKey[record.paneKey]!.resumeTargetPaneKey!
    const parsed = parseWorkspaceSession(
      JSON.parse(JSON.stringify(buildWorkspaceSessionPayload(state)))
    )
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(
        parsed.value.sleepingAgentSessionsByPaneKey?.[target]?.launchConfig?.agentArgs
      ).toContain('synthetic-recovery-model')
    }
  })

  it('retains the fence when the destination tab is missing after reload', () => {
    const { record } = launch()
    useAppStore.setState({
      tabsByWorktree: { [worktreeId]: [] },
      pendingStartupByTabId: {},
      automaticAgentResumeClaimsByTabId: {}
    })
    expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBeDefined()
    expect(
      pendingConversationRecoveries(
        useAppStore.getState().sleepingAgentSessionsByPaneKey,
        worktreeId
      )
    ).toHaveLength(1)
  })

  it('keeps an unconfirmed conversation accessible after the recovery tab is closed', () => {
    const { record, tab } = launch()
    useAppStore.getState().closeTab(tab.id)
    const pending = pendingConversationRecoveries(
      useAppStore.getState().sleepingAgentSessionsByPaneKey,
      worktreeId
    )
    expect(pending).toHaveLength(1)
    expect(pending[0]?.providerSession).toEqual(record.providerSession)
    expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(0)
  })

  it('does not resurrect an old record when the same session reports a completed turn', () => {
    const record = seed()
    const tab = useAppStore.getState().createTab(worktreeId)
    useAppStore.setState({
      agentStatusByPaneKey: {
        'different:leaf': {
          paneKey: 'different:leaf',
          tabId: tab.id,
          worktreeId,
          agentType: record.agent,
          providerSession: record.providerSession,
          prompt: '',
          state: 'done',
          updatedAt: 1,
          stateStartedAt: 1,
          stateHistory: []
        }
      }
    })
    expect(resumeSleepingAgentSessionsForWorktree(worktreeId)).toBe(0)
    expect(useAppStore.getState().tabsByWorktree[worktreeId]).toHaveLength(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('does not let a wrong-provider hook overwrite pending destination identity', () => {
    const { record, target, tab } = launch()
    useAppStore
      .getState()
      .setAgentStatus(
        target,
        { state: 'working', agentType: 'codex', prompt: '' },
        undefined,
        undefined,
        { tabId: tab.id, worktreeId },
        { providerSession: { key: 'session_id', id: 'wrong-session' } }
      )
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[target]?.providerSession).toEqual(
      record.providerSession
    )
    useAppStore.getState().captureAllSleepingAgentSessions('quit')
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[target]?.providerSession).toEqual(
      record.providerSession
    )
    useAppStore.getState().registerAgentLaunchConfig(
      target,
      { agentArgs: '', agentEnv: {} },
      {
        agentType: 'codex',
        tabId: tab.id
      }
    )
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[target]?.providerSession).toEqual(
      record.providerSession
    )
  })

  it.each(['provider', 'status'])(
    'confirms through %s and keeps the source backup fenced after close',
    (path) => {
      const { record, target, tab } = launch()
      if (path === 'provider') {
        useAppStore
          .getState()
          .recordAgentProviderSession(target, record.agent, record.providerSession, undefined, {
            tabId: tab.id,
            worktreeId
          })
      } else {
        useAppStore
          .getState()
          .setAgentStatus(
            target,
            { state: 'working', agentType: record.agent, prompt: '' },
            undefined,
            undefined,
            { tabId: tab.id, worktreeId },
            { providerSession: record.providerSession }
          )
      }
      const state = useAppStore.getState()
      expect(state.sleepingAgentSessionsByPaneKey[target]?.resumeTargetPaneKey).toBeUndefined()
      expect(state.sleepingAgentSessionsByPaneKey[target]?.providerSession).toEqual(
        record.providerSession
      )
      expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]?.resumeTargetPaneKey).toBe(target)
      expect(
        state.sleepingAgentSessionsByPaneKey[record.paneKey]?.resumeConfirmedAt
      ).toBeGreaterThan(0)
      state.closeTab(tab.id)
      expect(
        pendingConversationRecoveries(
          useAppStore.getState().sleepingAgentSessionsByPaneKey,
          worktreeId
        )
      ).toEqual([])
      expect(
        useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]?.providerSession
      ).toEqual(record.providerSession)
    }
  )

  it('rewrites both recovery pointers during authoritative pane transfer', () => {
    const { record, target } = launch()
    const to = 'moved-tab:11111111-1111-4111-8111-111111111111'
    useAppStore
      .getState()
      .transferAgentPaneAuthority({ fromPaneKey: target, toPaneKey: to, ptyId: 'synthetic-pty' })
    const records = useAppStore.getState().sleepingAgentSessionsByPaneKey
    expect(records[record.paneKey]?.resumeTargetPaneKey).toBe(to)
    expect(records[to]?.resumeTargetPaneKey).toBe(to)
    expect(records[to]?.providerSession).toEqual(record.providerSession)
  })
})
