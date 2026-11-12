import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCachedPaneReplayEnvelope } from '../../../../../wsl-guest/agent-hook-cached-pane-status'
import type { AgentHookEventPayload } from '../../../../../shared/agent-hook-listener/listener-event'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { PANE } from '../server.test-fixtures'

import { attestFixtureHookContext } from '../attested-hook-context.test-fixtures'
vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

const CHILD = '01a16839-7f84-7ed3-aebf-ea51e50330cf'

// Fork 6d65165647: relayed Claude/Codex status is refused without attestation. The host-side
// transcript polling below is still exercised; the desktop refuses every relayed Codex row.
const REMOTE_REFUSAL = 'remote_context_attestation_unavailable'
function expectRefused(server: AgentHookServer, count: number): void {
  expect(server.getStatusSnapshot()).toEqual([])
  expect(server.getContextIntegrityRejections()).toEqual({ [REMOTE_REFUSAL]: count })
}

beforeEach(() => {
  _internals.resetCachesForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('remote Codex unlabelled roster removals', () => {
  const childStart = (id: string, startedAt: number): AgentHookEventPayload => ({
    paneKey: PANE,
    connectionId: null,
    source: 'codex',
    providerSession: { key: 'session_id', id: 'root' },
    hookEventName: 'SubagentStart',
    toolAgentId: id,
    payload: {
      agentType: 'codex',
      prompt: 'Run the checks',
      state: 'working',
      mainAgent: { state: 'working', stateStartedAt: 1 },
      subagents: [{ id, state: 'working', startedAt }]
    }
  })
  const emptyPoll = (mainState: 'working' | 'done', toolAgentId?: string) => ({
    paneKey: PANE,
    source: 'codex',
    providerSession: { key: 'session_id', id: 'root' },
    toolAgentId,
    payload: {
      agentType: 'codex',
      prompt: 'Run the checks',
      state: mainState,
      mainAgent: { state: mainState, stateStartedAt: 1 }
    }
  })

  it('keeps children a restarted relay never listed', () => {
    const server = attestFixtureHookContext(new AgentHookServer())
    server.beginRemoteRelaySession('wsl:Ubuntu')
    server.ingestRemote(childStart(CHILD, 1), 'wsl:Ubuntu')
    server.beginRemoteRelaySession('wsl:Ubuntu')
    const replay = buildCachedPaneReplayEnvelope({
      event: { ...childStart(CHILD, 1), hookEventName: 'SessionStart', toolAgentId: undefined },
      meta: { source: 'codex' }
    })
    server.ingestRemote(replay, 'wsl:Ubuntu')
    server.ingestRemote(emptyPoll('done'), 'wsl:Ubuntu')
    // The relayed Codex start, its cached replay and the poll are all refused; no roster forms.
    expectRefused(server, 3)
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
    server._getStateForTests().codexSubagentRosterByPaneKey.delete(PANE)
    server.ingestRemote(replay, 'wsl:Ubuntu')
    server.ingestRemote(emptyPoll('done'), 'wsl:Ubuntu')
    expectRefused(server, 5)

    server.ingestRemote(childStart(CHILD, 1), 'wsl:Ubuntu')
    server.ingestRemote(emptyPoll('done'), 'wsl:Ubuntu')
    expectRefused(server, 7)
  })
})
