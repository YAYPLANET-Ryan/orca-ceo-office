import { describe, expect, it } from 'vitest'
import { sleepingAgentSessionsByPaneKeySchema } from '../../../../shared/workspace-session-sleeping-agents'
import { createTestStore, makeTab } from './store-test-helpers'

const paneKey = 'tab-1:leaf-1'
const providerSession = { key: 'session_id' as const, id: 'continuity-test-session' }
const launchConfig = {
  agentArgs: '--model test-model -c model_reasoning_effort="medium"',
  agentEnv: { TEST_PROFILE: 'continuity' }
}

function seedSession() {
  const store = createTestStore()
  store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
  store.getState().registerAgentLaunchConfig(paneKey, launchConfig, {
    agentType: 'codex',
    launchToken: 'test-launch',
    tabId: 'tab-1',
    leafId: 'leaf-1'
  })
  const reportWorking = () =>
    store
      .getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'synthetic task', agentType: 'codex' },
        undefined,
        undefined,
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession, launchToken: 'test-launch' }
      )
  reportWorking()
  return { store, reportWorking }
}

describe('confirmed process exit continuity', () => {
  it('retains the exact provider and launch settings after live status is retired', () => {
    const { store } = seedSession()
    store.getState().markSleepingAgentSessionExited(paneKey)
    store.getState().dropAgentStatus(paneKey)
    const record = store.getState().sleepingAgentSessionsByPaneKey[paneKey]
    expect(record).toMatchObject({ providerSession, launchConfig, requiresManualResume: true })
    expect(store.getState().agentStatusByPaneKey[paneKey]).toBeUndefined()
    const hydrated = sleepingAgentSessionsByPaneKeySchema.parse(
      JSON.parse(JSON.stringify({ [paneKey]: record }))
    )
    expect(hydrated?.[paneKey]).toEqual(record)
  })

  it.each(['periodic', 'quit'] as const)('keeps the exit fence through %s capture', (mode) => {
    const { store } = seedSession()
    store.getState().markSleepingAgentSessionExited(paneKey)
    store.getState().captureAllSleepingAgentSessions(mode)
    expect(store.getState().sleepingAgentSessionsByPaneKey[paneKey]?.requiresManualResume).toBe(
      true
    )
  })

  it('clears the old exit fence when the same conversation reports fresh live status', () => {
    const { store, reportWorking } = seedSession()
    store.getState().markSleepingAgentSessionExited(paneKey)
    reportWorking()
    expect(
      store.getState().sleepingAgentSessionsByPaneKey[paneKey]?.requiresManualResume
    ).toBeUndefined()
  })

  it('does not invent a provider identity for an unknown pane', () => {
    const { store } = seedSession()
    store.getState().markSleepingAgentSessionExited('unknown:leaf')
    expect(store.getState().sleepingAgentSessionsByPaneKey['unknown:leaf']).toBeUndefined()
    expect(
      store.getState().sleepingAgentSessionsByPaneKey[paneKey]?.requiresManualResume
    ).toBeUndefined()
  })
})
