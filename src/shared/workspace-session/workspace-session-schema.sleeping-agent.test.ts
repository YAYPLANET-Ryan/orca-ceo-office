import { describe, it, expect } from 'vitest'
import { parseWorkspaceSession } from './workspace-session-schema'

describe('parseWorkspaceSession sleeping agents', () => {
  it.each([
    { target: 'replacement-tab:1', expectedTarget: 'replacement-tab:1' },
    { target: undefined, expectedTarget: undefined },
    { target: '', expectedTarget: undefined }
  ])('retains legacy recovery through disk round trips ($target)', ({ target, expectedTarget }) => {
    const record = {
      paneKey: 'original-tab:1',
      tabId: 'original-tab',
      worktreeId: 'wt',
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'original-conversation' },
      prompt: '',
      state: 'done',
      capturedAt: 10,
      updatedAt: 10,
      origin: 'live',
      requiresManualResume: true,
      resumeTargetPaneKey: target
    }
    const first = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    })
    expect(first.ok).toBe(true)
    if (!first.ok) {
      throw new Error('Legacy recovery record was rejected')
    }
    const second = parseWorkspaceSession(JSON.parse(JSON.stringify(first.value)))
    expect(second.ok).toBe(true)
    if (!second.ok) {
      throw new Error('Recovery record failed its second hydration')
    }
    const restored = second.value.sleepingAgentSessionsByPaneKey?.['original-tab:1']
    expect(restored).toMatchObject({
      paneKey: 'original-tab:1',
      providerSession: { key: 'session_id', id: 'original-conversation' },
      requiresManualResume: true
    })
    expect(restored?.resumeTargetPaneKey).toBe(expectedTarget)
  })

  it.each([undefined, 'legacy-orchestration-worker'])(
    'new host ignores an old client resume fence (%s)',
    (automaticResumeBlockedBy) => {
      const record = {
        paneKey: 'tab1:pane-1',
        tabId: 'tab1',
        worktreeId: 'wt',
        agent: 'codex',
        providerSession: { key: 'session_id', id: 'codex-session' },
        prompt: 'continue',
        state: 'done',
        capturedAt: 10,
        updatedAt: 10,
        origin: 'worktree-sleep'
      }
      const result = parseWorkspaceSession({
        activeRepoId: null,
        activeWorktreeId: null,
        activeTabId: null,
        tabsByWorktree: {},
        terminalLayoutsByTabId: {},
        sleepingAgentSessionsByPaneKey: {
          [record.paneKey]: { ...record, automaticResumeBlockedBy }
        }
      })
      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.value.sleepingAgentSessionsByPaneKey?.[record.paneKey]).toEqual(record)
      }
    }
  )

  it('preserves the authoritative Pi session file through hydration', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'pi',
          providerSession: {
            key: 'session_id',
            id: 'pi-session',
            transcriptPath: '/tmp/pi-session.jsonl'
          },
          prompt: '',
          state: 'working',
          capturedAt: 10,
          updatedAt: 10,
          origin: 'live'
        }
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']?.providerSession).toEqual(
        {
          key: 'session_id',
          id: 'pi-session',
          transcriptPath: '/tmp/pi-session.jsonl'
        }
      )
    }
  })

  it("preserves a Claude session's effort level through hydration", () => {
    const providerSession = { key: 'session_id', id: 'claude-session', effort: 'max' }
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'claude',
          providerSession,
          prompt: '',
          state: 'done',
          capturedAt: 10,
          updatedAt: 10,
          origin: 'live'
        }
      }
    })

    expect(
      result.ok && result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']?.providerSession
    ).toEqual(providerSession)
  })

  it('preserves the AI Vault OMP resume file through hydration', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'omp',
          providerSession: { key: 'session_id', id: 'omp-session' },
          prompt: '',
          state: 'working',
          capturedAt: 10,
          updatedAt: 10,
          launchConfig: {
            agentArgs: '',
            agentEnv: {},
            ompResumeFilePath: '/custom/omp-sessions/project/session.jsonl'
          },
          origin: 'quit'
        }
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(
        result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']?.launchConfig
          ?.ompResumeFilePath
      ).toBe('/custom/omp-sessions/project/session.jsonl')
    }
  })

  it('drops Pi sleeping-agent records without an authoritative session file', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'pi',
          providerSession: { key: 'session_id', id: 'pi-session' },
          prompt: '',
          state: 'done',
          capturedAt: 10,
          updatedAt: 10,
          origin: 'live'
        }
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sleepingAgentSessionsByPaneKey).toBeUndefined()
    }
  })

  it('drops invalid sleeping agent launch config without dropping the record', () => {
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: {
        'tab1:pane-1': {
          paneKey: 'tab1:pane-1',
          tabId: 'tab1',
          worktreeId: 'wt',
          agent: 'codex',
          providerSession: { key: 'session_id', id: 'codex-session' },
          prompt: 'continue',
          state: 'working',
          capturedAt: 10,
          updatedAt: 9,
          launchConfig: {
            agentArgs: '--model high',
            agentEnv: { 'BAD=KEY': 'value' }
          }
        }
      }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      const record = result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']
      expect(record?.agent).toBe('codex')
      expect(record?.launchConfig).toBeUndefined()
    }
  })

  it('drops launch config with prototype-polluting env keys without dropping siblings', () => {
    const sessions = JSON.parse(`{
      "__proto__": {
        "paneKey": "__proto__",
        "worktreeId": "wt",
        "agent": "codex",
        "providerSession": { "key": "session_id", "id": "bad-session" },
        "prompt": "bad",
        "state": "working",
        "capturedAt": 10,
        "updatedAt": 9
      },
      "tab1:pane-1": {
        "paneKey": "tab1:pane-1",
        "tabId": "tab1",
        "worktreeId": "wt",
        "agent": "codex",
        "providerSession": { "key": "session_id", "id": "codex-session" },
        "prompt": "continue",
        "state": "working",
        "capturedAt": 10,
        "updatedAt": 9,
        "launchConfig": {
          "agentArgs": "",
          "agentEnv": { "__proto__": "polluted" }
        }
      }
    }`)
    const result = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      sleepingAgentSessionsByPaneKey: sessions
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Object.hasOwn(result.value.sleepingAgentSessionsByPaneKey ?? {}, '__proto__')).toBe(
        false
      )
      const record = result.value.sleepingAgentSessionsByPaneKey?.['tab1:pane-1']
      expect(record?.agent).toBe('codex')
      expect(record?.launchConfig).toBeUndefined()
      expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    }
  })
})
