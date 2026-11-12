import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../../../../../wsl-guest/agent-hook-server'
import { buildCachedPaneReplayEnvelope } from '../../../../../../wsl-guest/agent-hook-cached-pane-status'
import type { AgentHookEventPayload } from '../../../../../../shared/agent-hook-listener/listener-event'
import type { AgentHookRelayEnvelope } from '../../../../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { AgentHookServer } from '../../../agent-hook-server'
import { selectFreshExplicitAgentStatus } from '../../../../../runtime/workspaces/process-listing/runtime-hook-agent-row-selection'
import { buildBody, postHookEvent, PANE } from '../../server.test-fixtures'
import { attestFixtureHookContext } from '../../attested-hook-context.test-fixtures'

// Fork 6d65165647: relayed Claude/Codex status is refused without attestation, so the relay
// routes below assert the refusal and an empty desktop; local Codex hooks come from an
// attested pane.
const REMOTE_REFUSAL = 'remote_context_attestation_unavailable'
function remoteRefusals(server: AgentHookServer): number {
  return server.getContextIntegrityRejections()[REMOTE_REFUSAL] ?? 0
}

function previousRoot(children: number): AgentHookEventPayload {
  return {
    paneKey: PANE,
    connectionId: null,
    worktreeId: 'old-owner',
    source: 'codex',
    hookEventName: 'SubagentStart',
    toolAgentId: 'old-0',
    providerSession: { key: 'session_id', id: 'old-root' },
    payload: {
      agentType: 'codex',
      state: 'working',
      model: 'old-model',
      prompt: 'old task',
      mainAgent: { state: 'done', stateStartedAt: 1000 },
      subagents: Array.from({ length: children }, (_, index) => ({
        id: `old-${index}`,
        state: 'working',
        startedAt: 1000
      }))
    }
  }
}

it.each([10, 100])(
  'refuses %i relayed foreign-session children and their cached startup boundary',
  (children) => {
    const desktop = attestFixtureHookContext(new AgentHookServer())
    desktop.beginRemoteRelaySession('wsl:Ubuntu')
    desktop.ingestRemote(previousRoot(children), 'wsl:Ubuntu')
    if (children === 100) {
      desktop.beginRemoteRelaySession('wsl:Ubuntu')
    }
    const incoming: AgentHookEventPayload = {
      ...previousRoot(0),
      toolAgentId: undefined,
      hookEventName: 'SessionStart',
      providerSession: { key: 'session_id', id: 'new-root' },
      payload: {
        agentType: 'codex',
        state: 'done',
        sessionBoundary: true,
        prompt: 'new context',
        model: 'new-model',
        mainAgent: { state: 'done', outcome: 'cancellation', stateStartedAt: 2000 }
      }
    }
    desktop.ingestRemote(
      buildCachedPaneReplayEnvelope({ event: incoming, meta: { source: 'codex' } }),
      'wsl:Ubuntu'
    )
    desktop.ingestRemote({ ...incoming, hookEventName: undefined }, 'wsl:Ubuntu')
    expect(remoteRefusals(desktop)).toBe(3)
    expect(desktop.getStatusSnapshot()).toEqual([])
    expect(desktop._getStateForTests().codexSubagentRosterByPaneKey.get(PANE)).toBeUndefined()
  }
)

it.each(['previous', 'incoming'] as const)(
  'refuses relayed live context when the %s session ID is missing',
  (missing) => {
    const desktop = attestFixtureHookContext(new AgentHookServer())
    const previous = previousRoot(1)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    try {
      desktop.ingestRemote(
        {
          ...previous,
          hookEventName: 'UserPromptSubmit',
          toolAgentId: undefined,
          hasExplicitPrompt: true,
          providerSession: missing === 'previous' ? undefined : previous.providerSession,
          payload: { ...previous.payload, mainAgent: { state: 'working', stateStartedAt: 1000 } }
        },
        'wsl:Ubuntu'
      )
      expect(remoteRefusals(desktop)).toBe(1)
      expect(desktop.getStatusSnapshot()).toEqual([])
      vi.setSystemTime(3_000)
      desktop.ingestRemote(
        {
          ...previous,
          toolAgentId: undefined,
          hookEventName: 'SessionStart',
          providerSession:
            missing === 'incoming' ? undefined : { key: 'session_id', id: 'new-root' },
          payload: { agentType: 'codex', state: 'working', prompt: '' }
        },
        'wsl:Ubuntu'
      )
      expect(remoteRefusals(desktop)).toBe(2)
      expect(desktop.getStatusSnapshot()).toEqual([])
    } finally {
      desktop.stop()
      vi.useRealTimers()
    }
  }
)

it.each(['local', 'relay', 'old-relay', 'old-relay-no-main'] as const)(
  'separates Codex session identity from live turns on %s',
  async (route) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    const directory = mkdtempSync(join(tmpdir(), 'codex-session-start-'))
    const desktop = attestFixtureHookContext(new AgentHookServer())
    let forwarded: AgentHookRelayEnvelope | undefined
    const relay =
      route === 'local'
        ? undefined
        : new RelayAgentHookServer({
            endpointDir: directory,
            forward: (event) => {
              forwarded = event
              return desktop.ingestRemote(
                route.startsWith('old-') && event.hookEventName === 'SessionStart'
                  ? {
                      ...event,
                      payload: {
                        ...event.payload,
                        state: 'working',
                        sessionBoundary: undefined,
                        mainAgent:
                          route === 'old-relay-no-main'
                            ? undefined
                            : { state: 'working', stateStartedAt: 900 }
                      }
                    }
                  : event,
                'ssh-connection'
              )
            }
          })
    await desktop.start({ env: 'production' })
    await relay?.start()
    async function post(payload: Record<string, unknown>): Promise<void> {
      const body = buildBody({ session_id: 'root-session', ...payload })
      const coordinates = relay?.getCoordinates()
      const response = coordinates
        ? await fetch(`http://127.0.0.1:${coordinates.port}/hook/codex`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Connection: 'close',
              'X-Orca-Agent-Hook-Token': coordinates.token
            },
            body: JSON.stringify(body)
          })
        : await postHookEvent(desktop, body, '/hook/codex')
      expect(response.status).toBe(204)
    }
    try {
      if (route !== 'local') {
        await post({ hook_event_name: 'SessionStart', source: 'startup' })
        await post({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'review' })
        // The relay forwards both hooks; the desktop refuses each without attestation.
        expect(forwarded).toMatchObject({ hookEventName: 'UserPromptSubmit' })
        expect(remoteRefusals(desktop)).toBe(2)
        expect(desktop.getStatusSnapshot()).toEqual([])
        return
      }
      await post({ hook_event_name: 'SessionStart', source: 'startup' })
      expect(desktop.getStatusSnapshot()[0]).toMatchObject({
        state: 'done',
        sessionBoundary: true,
        mainAgent: { state: 'done' }
      })
      expect(desktop.getStatusSnapshot()[0].turnStartedAt).toBeUndefined()
      expect(desktop.getStatusSnapshot()[0].turnEndedAt).toBeUndefined()
      await post({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'review' })
      expect(desktop.getStatusSnapshot()[0].turnStartedAt).toBe(1_000)
      await post({ hook_event_name: 'SubagentStart', agent_id: 'child-session' })
      vi.setSystemTime(2_000)
      await post({ hook_event_name: 'SessionStart', source: 'compact' })
      expect(desktop.getStatusSnapshot()[0]).toMatchObject({
        state: 'working',
        prompt: 'review',
        turnStartedAt: 1_000,
        mainAgent: { state: 'working', stateStartedAt: 1_000 },
        subagents: [{ id: 'child-session', state: 'working' }],
        providerSession: { id: 'root-session' }
      })
      await post({ hook_event_name: 'SessionStart', source: 'future-continuation' })
      expect(desktop.getStatusSnapshot()[0].mainAgent).toMatchObject({ stateStartedAt: 1_000 })
      // A schema-shaped legacy child start must not take over its parent's row.
      await post({
        hook_event_name: 'SessionStart',
        source: 'resume',
        session_id: 'child-session',
        transcript_path: join(directory, 'child-rollout.jsonl')
      })
      expect(desktop.getStatusSnapshot()[0]).toMatchObject({
        mainAgent: { state: 'working', stateStartedAt: 1_000 },
        providerSession: { id: 'root-session' }
      })
      if (route === 'local') {
        vi.setSystemTime(2_500)
        await post({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'review' })
        expect(desktop.getStatusSnapshot()[0].mainAgent).toMatchObject({ stateStartedAt: 1_000 })
      }
      vi.setSystemTime(3_000)
      await post({
        hook_event_name: 'PreToolUse',
        tool_name: 'request_user_input',
        tool_input: { questions: [] }
      })
      vi.setSystemTime(4_000)
      await post({ hook_event_name: 'SessionStart', source: 'compact' })
      expect(desktop.getStatusSnapshot()[0]).toMatchObject({
        state: 'waiting',
        turnStartedAt: route === 'local' ? 2_500 : 1_000,
        prompt: 'review',
        toolName: 'request_user_input',
        mainAgent: { state: 'waiting', stateStartedAt: 3_000 },
        subagents: [{ id: 'child-session', state: 'working' }]
      })
      if (route === 'local' || route === 'relay') {
        vi.setSystemTime(5_000)
        await post({ hook_event_name: 'PostToolUse', tool_name: 'Bash' })
        vi.setSystemTime(6_000)
        await post({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-2', prompt: 'next turn' })
        expect(desktop.getStatusSnapshot()[0].mainAgent).toMatchObject({ stateStartedAt: 6_000 })
        await post({ hook_event_name: 'Stop' })
        await post({ hook_event_name: 'SubagentStart', agent_id: 'child-session' })
        expect(desktop.getStatusSnapshot()[0]).toMatchObject({
          state: 'working',
          mainAgent: { state: 'done', stateStartedAt: 6_000 },
          subagents: [{ id: 'child-session', state: 'working' }]
        })
        vi.setSystemTime(7_000)
        await post({ hook_event_name: 'SessionStart', source: 'compact' })
        expect(desktop.getStatusSnapshot()[0]).toMatchObject({
          state: 'working',
          mainAgent: { state: 'done', stateStartedAt: 6_000 },
          subagents: [{ id: 'child-session', state: 'working' }]
        })
        await post({ hook_event_name: 'SubagentStop', agent_id: 'child-session' })
        await post({ hook_event_name: 'Interrupt' })
        vi.setSystemTime(8_000)
        await post({ hook_event_name: 'SessionStart', source: 'compact' })
        expect(desktop.getStatusSnapshot()[0]).toMatchObject({
          state: 'done',
          sessionBoundary: true,
          turnStartedAt: 6_000,
          mainAgent: { state: 'done', stateStartedAt: 6_000, outcome: 'cancellation' }
        })
        await post({
          hook_event_name: 'UserPromptSubmit',
          turn_id: 'turn-3',
          prompt: 'old session work'
        })
        expect(desktop.getStatusSnapshot()[0].turnStartedAt).toBe(8_000)
        vi.setSystemTime(9_000)
        await post({ hook_event_name: 'Stop', last_assistant_message: 'old reply' })
        expect(desktop.getStatusSnapshot()[0].turnEndedAt).toBe(9_000)
        if (route === 'local') {
          expect(desktop.getAcceptedReply(PANE, 9_000)).toBe('old reply')
        }
        vi.setSystemTime(route === 'local' ? 9_000 : 10_000)
        await post({
          hook_event_name: 'SessionStart',
          source: 'startup',
          session_id: 'replacement-session',
          transcript_path: join(directory, 'replacement.jsonl')
        })
        expect(desktop.getStatusSnapshot()[0]).toMatchObject({
          state: 'done',
          sessionBoundary: true,
          mainAgent: { state: 'done' },
          providerSession: { id: 'replacement-session' }
        })
        expect(desktop.getStatusSnapshot()[0].turnStartedAt).toBeUndefined()
        expect(desktop.getStatusSnapshot()[0].turnEndedAt).toBeUndefined()
        expect(desktop.getStatusSnapshot()[0].turnEndDisposition).toBeUndefined()
        expect(desktop.getStatusSnapshot()[0].stateStartedAt).toBe(
          route === 'local' ? 9_000 : 10_000
        )
        expect(desktop.getAcceptedReply(PANE, 9_000)).toBeUndefined()
        vi.setSystemTime(11_000)
        await post({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'replacement-session',
          prompt: 'replacement task'
        })
        expect(desktop.getStatusSnapshot()[0]).toMatchObject({
          state: 'working',
          prompt: 'replacement task',
          turnStartedAt: 11_000
        })
      }
    } finally {
      relay?.stop()
      desktop.stop()
      vi.useRealTimers()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)

it('refuses relayed Codex work across a restart and its replays', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-restored-start-'))
  const first = attestFixtureHookContext(new AgentHookServer())
  const desktop = attestFixtureHookContext(new AgentHookServer())
  const event = {
    paneKey: PANE,
    source: 'codex' as const,
    providerSession: { key: 'session_id' as const, id: 'root-session' },
    payload: {
      state: 'working' as const,
      agentType: 'codex' as const,
      prompt: 'old task',
      mainAgent: { state: 'working' as const, stateStartedAt: 1_000 }
    }
  }
  try {
    await first.start({ env: 'production', userDataPath: directory })
    first.ingestRemote({ ...event, hookEventName: 'UserPromptSubmit' }, 'ssh-connection')
    expect(remoteRefusals(first)).toBe(1)
    first.flushStatusPersistSync()
    first.stop()
    await desktop.start({ env: 'production', userDataPath: directory })
    // Nothing relayed was admitted, so nothing is restored.
    expect(desktop.getStatusSnapshot()).toEqual([])
    desktop.ingestRemote({ ...event, hookEventName: 'SessionStart' }, 'ssh-connection')
    desktop.ingestRemote(
      { ...event, hookEventName: 'SessionStart', hasExplicitPrompt: true, isReplay: true },
      'ssh-connection'
    )
    desktop.ingestRemote(
      { ...event, hookEventName: 'UserPromptSubmit', hasExplicitPrompt: true },
      'ssh-connection'
    )
    expect(remoteRefusals(desktop)).toBe(3)
    expect(desktop.getStatusSnapshot()).toEqual([])
    expect(
      selectFreshExplicitAgentStatus({
        handle: 'fixture',
        paneKey: PANE,
        hookRows: desktop.getStatusSnapshot()
      })
    ).toBeNull()
  } finally {
    vi.restoreAllMocks()
    first.stop()
    desktop.stop()
    rmSync(directory, { recursive: true, force: true })
  }
})
