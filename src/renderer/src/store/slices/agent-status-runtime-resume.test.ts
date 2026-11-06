import { describe, expect, it } from 'vitest'
import { createTestStore, makeTab } from './store-test-helpers'

describe('runtime resume identity recording', () => {
  it.each(['codex', 'claude'] as const)(
    'preserves observed %s work while storing its resume identity',
    (agent) => {
      const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
      const store = createTestStore()
      store.setState({ tabsByWorktree: { 'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })] } })
      store
        .getState()
        .setAgentStatus(
          paneKey,
          { state: 'working', prompt: 'existing turn', agentType: agent },
          undefined,
          { updatedAt: 10, stateStartedAt: 10 },
          { tabId: 'tab-1', worktreeId: 'wt-1' }
        )
      const providerSession = { key: 'session_id' as const, id: 'original-session' }
      store
        .getState()
        .recordAgentProviderSession(
          paneKey,
          agent,
          providerSession,
          { updatedAt: 20 },
          { tabId: 'tab-1', worktreeId: 'wt-1' },
          { preserveLiveStatus: true }
        )
      expect(store.getState().agentStatusByPaneKey[paneKey]).toMatchObject({
        state: 'working',
        prompt: 'existing turn',
        updatedAt: 10,
        providerSession
      })
      expect(store.getState().sleepingAgentSessionsByPaneKey[paneKey]).toMatchObject({
        agent,
        providerSession,
        origin: 'live'
      })
    }
  )
})
