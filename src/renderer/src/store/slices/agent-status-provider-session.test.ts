import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { AppState } from '../types'
import { getProviderSessionClaimKey } from '../../lib/sleeping-agent-pane-ownership'
import { createTestStore, makeTab } from './store-test-helpers'

const PI_COMPATIBLE_CASES = [
  { agent: 'pi' as const, label: 'Pi' },
  { agent: 'omp' as const, label: 'OMP' },
  { agent: 'prime-agent' as const, label: 'Prime Agent' }
]

function makePiCompatibleProviderSession(agent: 'pi' | 'omp' | 'prime-agent') {
  const session = { key: 'session_id' as const, id: `${agent}-session-1` }
  return agent === 'omp' ? session : { ...session, transcriptPath: `/tmp/${agent}-session-1.jsonl` }
}

describe('nested hooks under a foreground parent', () => {
  it('keeps an idle Claude pane and its session when codex exec posts hooks from inside it', () => {
    const store = createTestStore()
    const claudeSession = { key: 'session_id' as const, id: 'claude-parent' }
    store
      .getState()
      .setPaneForegroundAgent('tab-1:leaf-1', { agent: 'claude', shellForeground: false })
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'done', prompt: 'idle at prompt', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        undefined,
        { providerSession: claudeSession }
      )

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'codex exec from a Claude tool call', agentType: 'codex' },
        'Codex',
        { updatedAt: 20, stateStartedAt: 20 },
        undefined,
        { providerSession: { key: 'session_id', id: 'codex-child' } }
      )

    const entry = store.getState().agentStatusByPaneKey['tab-1:leaf-1']
    expect(entry?.agentType).toBe('claude')
    expect(entry?.providerSession).toEqual(claudeSession)
  })

  it('does not trust revoked foreground evidence to keep a stale identity', () => {
    const store = createTestStore()
    store.getState().setPaneForegroundAgent('tab-1:leaf-1', {
      agent: 'claude',
      shellForeground: false,
      routingRevoked: true
    })
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'done', prompt: 'idle at prompt', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        undefined,
        { providerSession: { key: 'session_id', id: 'claude-parent' } }
      )

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'codex after a crashed claude', agentType: 'codex' },
        'Codex',
        { updatedAt: 20, stateStartedAt: 20 },
        undefined,
        { providerSession: { key: 'session_id', id: 'codex-new' } }
      )

    const entry = store.getState().agentStatusByPaneKey['tab-1:leaf-1']
    expect(entry?.agentType).toBe('codex')
    expect(entry?.providerSession).toEqual({ key: 'session_id', id: 'codex-new' })
  })

  it("ignores a shell return observed before the parent's last hook, and revoked shell evidence", () => {
    for (const evidence of [
      { entry: { agent: null, shellForeground: true }, observedAt: 5 },
      { entry: { agent: null, shellForeground: true, routingRevoked: true }, observedAt: 15 }
    ]) {
      const store = createTestStore()
      store.getState().setPaneForegroundAgent('tab-1:leaf-1', evidence.entry, {
        observedAt: evidence.observedAt
      })
      store
        .getState()
        .setAgentStatus(
          'tab-1:leaf-1',
          { state: 'working', prompt: 'claude turn', agentType: 'claude' },
          'Claude',
          { updatedAt: 10, stateStartedAt: 10 },
          undefined,
          { providerSession: { key: 'session_id', id: 'claude-parent' } }
        )
      store.getState().setAgentStatus(
        'tab-1:leaf-1',
        {
          state: 'working',
          prompt: 'codex exec from the active claude turn',
          agentType: 'codex'
        },
        'Codex',
        { updatedAt: 20, stateStartedAt: 20 },
        undefined,
        { providerSession: { key: 'session_id', id: 'codex-child' } }
      )
      // Why: a stale or revoked shell return must not hand an active parent's pane
      // to its nested child; the parent turn rule still protects it.
      const entry = store.getState().agentStatusByPaneKey['tab-1:leaf-1']
      expect(entry?.agentType).toBe('claude')
      expect(entry?.providerSession).toEqual({ key: 'session_id', id: 'claude-parent' })
    }
  })

  it('applies the identity main resolved instead of resolving again from local evidence', () => {
    const store = createTestStore()
    store
      .getState()
      .setPaneForegroundAgent('tab-1:leaf-1', { agent: 'claude', shellForeground: false })
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'claude turn', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        undefined,
        { providerSession: { key: 'session_id', id: 'claude-parent' } }
      )
    // Why: locally this would be a nested child (active parent, Claude foreground);
    // main saw the shell return in between and ruled a takeover. Its verdict wins.
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'codex after claude exited', agentType: 'codex' },
        'Codex',
        { updatedAt: 20, stateStartedAt: 20 },
        undefined,
        {
          providerSession: { key: 'session_id', id: 'codex-new' },
          resolvedIdentity: { agentType: 'codex', inheritedFromActivePane: false }
        }
      )

    const entry = store.getState().agentStatusByPaneKey['tab-1:leaf-1']
    expect(entry?.agentType).toBe('codex')
    expect(entry?.providerSession).toEqual({ key: 'session_id', id: 'codex-new' })
  })

  it('takes the provider session main supplied with an inherited verdict, not its own stale row', () => {
    const store = createTestStore()
    // Why: this store believes a fresh Codex/B owns the pane; main (which holds Claude/A)
    // ruled the next Claude event inherited and already substituted A for it.
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'codex turn', agentType: 'codex' },
        'Codex',
        { updatedAt: 10, stateStartedAt: 10 },
        undefined,
        { providerSession: { key: 'session_id', id: 'codex-b' } }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'claude turn', agentType: 'claude' },
        'Claude',
        { updatedAt: 20, stateStartedAt: 20 },
        undefined,
        {
          providerSession: { key: 'session_id', id: 'claude-a' },
          resolvedIdentity: { agentType: 'claude', inheritedFromActivePane: true }
        }
      )

    const entry = store.getState().agentStatusByPaneKey['tab-1:leaf-1']
    expect(entry?.agentType).toBe('claude')
    expect(entry?.providerSession).toEqual({ key: 'session_id', id: 'claude-a' })
  })

  it('lets a new agent take the pane once the shell foreground proves the parent exited', () => {
    const store = createTestStore()
    store
      .getState()
      .setPaneForegroundAgent('tab-1:leaf-1', { agent: 'claude', shellForeground: false })
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'done', prompt: 'idle at prompt', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        undefined,
        { providerSession: { key: 'session_id', id: 'claude-parent' } }
      )
    store.getState().setPaneForegroundAgent('tab-1:leaf-1', { agent: null, shellForeground: true })

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'fresh codex in the same pane', agentType: 'codex' },
        'Codex',
        { updatedAt: 20, stateStartedAt: 20 },
        undefined,
        { providerSession: { key: 'session_id', id: 'codex-new' } }
      )

    const entry = store.getState().agentStatusByPaneKey['tab-1:leaf-1']
    expect(entry?.agentType).toBe('codex')
    expect(entry?.providerSession).toEqual({ key: 'session_id', id: 'codex-new' })
  })
})

describe('recordAgentProviderSession', () => {
  it('preserves the root session while a child permission hook moves Codex to waiting', () => {
    const store = createTestStore()
    const providerSession = { key: 'session_id' as const, id: 'root-session' }

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'coordinate reviewers', agentType: 'codex' },
        'Codex',
        { updatedAt: 10, stateStartedAt: 10 },
        undefined,
        { providerSession }
      )
    store.getState().setAgentStatus('tab-1:leaf-1', {
      state: 'waiting',
      prompt: 'coordinate reviewers',
      agentType: 'codex',
      subagents: [{ id: 'child-1', state: 'waiting', startedAt: 11 }]
    })

    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']?.providerSession).toEqual(
      providerSession
    )
  })

  // Why: mobile Chat UI keys its transcript subscription on providerSession.id, so a
  // metadata-less end-of-turn `done` used to blank the chat every turn (#10630).
  it('keeps the provider session when the turn completes without session metadata', () => {
    const store = createTestStore()
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'summarize the diff', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        undefined,
        { providerSession }
      )
    store.getState().setAgentStatus('tab-1:leaf-1', {
      state: 'done',
      prompt: 'summarize the diff',
      agentType: 'claude'
    })

    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']?.providerSession).toEqual(
      providerSession
    )
  })

  // Why: `done` is the resting state, and both OSC 9999 repaints and reconnect snapshot
  // replays re-deliver a metadata-less `done` onto an already-done row. Retaining only the
  // first one still blanked the chat the moment a second landed (#10630).
  it('keeps the provider session across repeated metadata-less done pings', () => {
    const store = createTestStore()
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'summarize the diff', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        undefined,
        { providerSession }
      )
    for (const prompt of ['summarize the diff', 'summarize the diff again']) {
      store
        .getState()
        .setAgentStatus('tab-1:leaf-1', { state: 'done', prompt, agentType: 'claude' })
    }

    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']?.providerSession).toEqual(
      providerSession
    )
  })

  // Why: retention stops at the turn boundary. A metadata-less `working` after `done` starts
  // fresh work, so the finished session must not ride along into it.
  it('does not carry a completed session into the next turn', () => {
    const store = createTestStore()

    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'first', agentType: 'claude' },
        'Claude',
        { updatedAt: 10, stateStartedAt: 10 },
        undefined,
        { providerSession: { key: 'session_id' as const, id: 'claude-session-1' } }
      )
    store
      .getState()
      .setAgentStatus('tab-1:leaf-1', { state: 'done', prompt: 'first', agentType: 'claude' })
    store
      .getState()
      .setAgentStatus('tab-1:leaf-1', { state: 'working', prompt: 'second', agentType: 'claude' })

    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']?.providerSession).toBeUndefined()
  })

  it('uses the session file as part of transcript-based resume ownership only', () => {
    const base = {
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      prompt: '',
      state: 'working' as const,
      capturedAt: 10,
      updatedAt: 10,
      origin: 'live' as const
    }
    const makeRecord = (
      agent: 'pi' | 'prime-agent' | 'claude',
      transcriptPath: string
    ): SleepingAgentSessionRecord => ({
      ...base,
      agent,
      providerSession: { key: 'session_id', id: 'session-1', transcriptPath }
    })

    expect(getProviderSessionClaimKey(makeRecord('pi', '/tmp/first.jsonl'))).not.toBe(
      getProviderSessionClaimKey(makeRecord('pi', '/tmp/second.jsonl'))
    )
    expect(getProviderSessionClaimKey(makeRecord('prime-agent', '/tmp/first.jsonl'))).not.toBe(
      getProviderSessionClaimKey(makeRecord('prime-agent', '/tmp/second.jsonl'))
    )
    expect(getProviderSessionClaimKey(makeRecord('claude', '/tmp/first.jsonl'))).toBe(
      getProviderSessionClaimKey(makeRecord('claude', '/tmp/second.jsonl'))
    )
  })

  it('keeps Pi session identity durable without fabricating a visible turn', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    const launchConfig = {
      agentCommand: "pi '--model' 'anthropic/claude-sonnet-4'",
      agentArgs: '--model anthropic/claude-sonnet-4',
      agentEnv: { PI_CODING_AGENT_DIR: '/tmp/pi-agent' }
    }
    const providerSession = {
      key: 'session_id' as const,
      id: 'pi-session-1',
      transcriptPath: '/tmp/pi-session-1.jsonl'
    }

    store.getState().registerAgentLaunchConfig('tab-1:leaf-1', launchConfig, {
      agentType: 'pi',
      launchToken: 'pi-launch-1',
      tabId: 'tab-1',
      leafId: 'leaf-1'
    })
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'stale turn', agentType: 'pi' },
        'Pi',
        { updatedAt: 10, stateStartedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1' }
      )

    store
      .getState()
      .recordAgentProviderSession(
        'tab-1:leaf-1',
        'pi',
        providerSession,
        { updatedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: null },
        { launchToken: 'pi-launch-1' }
      )

    expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']).toBeUndefined()
    expect(store.getState().retainedAgentsByPaneKey['tab-1:leaf-1']).toBeUndefined()
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'pi',
      providerSession,
      launchConfig,
      origin: 'live'
    })

    const liveRecord = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']
    store.getState().captureAllSleepingAgentSessions('periodic')
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBe(liveRecord)

    store.getState().captureSleepingAgentSessionsByWorktree('wt-1', ['tab-1:leaf-1'])
    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      providerSession,
      launchConfig,
      origin: 'worktree-sleep'
    })
  })

  it('does not reuse Pi launch config when the session file identity changes', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      },
      sleepingAgentSessionsByPaneKey: {
        'tab-1:leaf-1': {
          paneKey: 'tab-1:leaf-1',
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          agent: 'pi',
          providerSession: {
            key: 'session_id',
            id: 'pi-session-1',
            transcriptPath: '/tmp/pi-session-old.jsonl'
          },
          prompt: '',
          state: 'working',
          capturedAt: 10,
          updatedAt: 10,
          launchConfig: { agentArgs: '--model old', agentEnv: { PI_PROFILE: 'old' } },
          origin: 'live'
        }
      }
    } as Partial<AppState>)

    store.getState().recordAgentProviderSession(
      'tab-1:leaf-1',
      'pi',
      {
        key: 'session_id',
        id: 'pi-session-1',
        transcriptPath: '/tmp/pi-session-new.jsonl'
      },
      { updatedAt: 20 },
      { tabId: 'tab-1', worktreeId: 'wt-1' }
    )

    expect(
      store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']?.launchConfig
    ).toBeUndefined()
  })

  it('preserves the legacy resume fence only for the same Pi session identity', () => {
    const store = createTestStore()
    const makeRecord = (transcriptPath: string): SleepingAgentSessionRecord => ({
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'pi',
      providerSession: {
        key: 'session_id',
        id: 'pi-session-1',
        transcriptPath
      },
      prompt: '',
      state: 'working',
      capturedAt: 10,
      updatedAt: 10,
      automaticResumeBlockedBy: 'legacy-orchestration-worker',
      origin: 'live'
    })
    store.setState({
      sleepingAgentSessionsByPaneKey: {
        'tab-1:leaf-1': makeRecord('/tmp/pi-session-1.jsonl')
      }
    } as Partial<AppState>)

    store.getState().recordAgentProviderSession(
      'tab-1:leaf-1',
      'pi',
      {
        key: 'session_id',
        id: 'pi-session-1',
        transcriptPath: '/tmp/pi-session-1.jsonl'
      },
      { updatedAt: 20 },
      { tabId: 'tab-1', worktreeId: 'wt-1' }
    )

    expect(
      store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']?.automaticResumeBlockedBy
    ).toBe('legacy-orchestration-worker')

    store.getState().recordAgentProviderSession(
      'tab-1:leaf-1',
      'pi',
      {
        key: 'session_id',
        id: 'pi-session-1',
        transcriptPath: '/tmp/pi-session-2.jsonl'
      },
      { updatedAt: 30 },
      { tabId: 'tab-1', worktreeId: 'wt-1' }
    )

    expect(
      store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']?.automaticResumeBlockedBy
    ).toBeUndefined()
  })

  it.each(PI_COMPATIBLE_CASES)(
    'keeps a completed $label session resumable through manual worktree sleep',
    async ({ agent, label }) => {
      const store = createTestStore()
      store.setState({
        tabsByWorktree: {
          'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
        }
      } as Partial<AppState>)
      const providerSession = makePiCompatibleProviderSession(agent)

      store
        .getState()
        .recordAgentProviderSession(
          'tab-1:leaf-1',
          agent,
          providerSession,
          { updatedAt: 10 },
          { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: 'ssh-connection-1' }
        )
      store
        .getState()
        .setAgentStatus(
          'tab-1:leaf-1',
          { state: 'working', prompt: 'finish the task', agentType: agent },
          label,
          { updatedAt: 20, stateStartedAt: 20 },
          { tabId: 'tab-1', worktreeId: 'wt-1' },
          { providerSession }
        )
      store
        .getState()
        .setAgentStatus(
          'tab-1:leaf-1',
          { state: 'done', prompt: 'finish the task', agentType: agent },
          label,
          { updatedAt: 30, stateStartedAt: 30 },
          { tabId: 'tab-1', worktreeId: 'wt-1' },
          { providerSession }
        )

      expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']?.state).toBe('done')
      const liveRecord = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']
      expect(liveRecord).toMatchObject({
        agent,
        providerSession,
        connectionId: 'ssh-connection-1',
        state: 'done',
        origin: 'live'
      })

      store.getState().captureAllSleepingAgentSessions('periodic')
      expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBe(liveRecord)

      await store.getState().shutdownWorktreeTerminals('wt-1', {
        keepIdentifiers: true,
        shutdownReason: 'manual-sleep',
        sleepingPaneKeys: ['tab-1:leaf-1']
      })

      expect(store.getState().agentStatusByPaneKey['tab-1:leaf-1']).toBeUndefined()
      expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
        agent,
        providerSession,
        connectionId: 'ssh-connection-1',
        state: 'working',
        origin: 'worktree-sleep'
      })
    }
  )

  it('does not turn a completed recovery record back into working on a same-session update', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    const providerSession = makePiCompatibleProviderSession('pi')

    store
      .getState()
      .recordAgentProviderSession(
        'tab-1:leaf-1',
        'pi',
        providerSession,
        { updatedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: 'ssh-connection-1' }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'finish the task', agentType: 'pi' },
        'Pi',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'done', prompt: 'finish the task', agentType: 'pi', interrupted: true },
        'Pi',
        { updatedAt: 30, stateStartedAt: 30 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )

    store
      .getState()
      .recordAgentProviderSession(
        'tab-1:leaf-1',
        'pi',
        providerSession,
        { updatedAt: 40 },
        { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: 'ssh-connection-1' }
      )

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      providerSession,
      state: 'done',
      interrupted: true,
      origin: 'live'
    })
  })

  it('does not downgrade a quit recovery record on a same-session update', () => {
    const store = createTestStore()
    store.setState({
      tabsByWorktree: {
        'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
      }
    } as Partial<AppState>)
    const providerSession = makePiCompatibleProviderSession('pi')

    store
      .getState()
      .recordAgentProviderSession(
        'tab-1:leaf-1',
        'pi',
        providerSession,
        { updatedAt: 10 },
        { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: 'ssh-connection-1' }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'working', prompt: 'finish the task', agentType: 'pi' },
        'Pi',
        { updatedAt: 20, stateStartedAt: 20 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )
    store
      .getState()
      .setAgentStatus(
        'tab-1:leaf-1',
        { state: 'done', prompt: 'finish the task', agentType: 'pi' },
        'Pi',
        { updatedAt: 30, stateStartedAt: 30 },
        { tabId: 'tab-1', worktreeId: 'wt-1' },
        { providerSession }
      )
    store.getState().captureAllSleepingAgentSessions('quit')

    store
      .getState()
      .recordAgentProviderSession(
        'tab-1:leaf-1',
        'pi',
        providerSession,
        { updatedAt: 40 },
        { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: 'ssh-connection-1' }
      )

    expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
      providerSession,
      state: 'done',
      origin: 'quit'
    })
  })

  it.each(PI_COMPATIBLE_CASES)(
    'keeps a completed $label session resumable through quit capture',
    ({ agent, label }) => {
      const store = createTestStore()
      store.setState({
        tabsByWorktree: {
          'wt-1': [makeTab({ id: 'tab-1', worktreeId: 'wt-1' })]
        }
      } as Partial<AppState>)
      const providerSession = makePiCompatibleProviderSession(agent)

      store
        .getState()
        .recordAgentProviderSession(
          'tab-1:leaf-1',
          agent,
          providerSession,
          { updatedAt: 10 },
          { tabId: 'tab-1', worktreeId: 'wt-1', connectionId: 'ssh-connection-1' }
        )
      store
        .getState()
        .setAgentStatus(
          'tab-1:leaf-1',
          { state: 'working', prompt: 'finish the task', agentType: agent },
          label,
          { updatedAt: 20, stateStartedAt: 20 },
          { tabId: 'tab-1', worktreeId: 'wt-1' },
          { providerSession }
        )
      store
        .getState()
        .setAgentStatus(
          'tab-1:leaf-1',
          { state: 'done', prompt: 'finish the task', agentType: agent },
          label,
          { updatedAt: 30, stateStartedAt: 30 },
          { tabId: 'tab-1', worktreeId: 'wt-1' },
          { providerSession }
        )

      store.getState().captureAllSleepingAgentSessions('periodic')
      expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toMatchObject({
        providerSession,
        connectionId: 'ssh-connection-1',
        origin: 'live'
      })

      store.getState().captureAllSleepingAgentSessions('quit')

      const quitRecord = store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']
      expect(quitRecord).toMatchObject({
        agent,
        providerSession,
        connectionId: 'ssh-connection-1',
        state: 'done',
        origin: 'quit'
      })

      store.getState().captureAllSleepingAgentSessions('periodic')
      expect(store.getState().sleepingAgentSessionsByPaneKey['tab-1:leaf-1']).toBe(quitRecord)
    }
  )
})
