import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { PANE } from '../server.test-fixtures'

import { attestFixtureHookContext } from '../attested-hook-context.test-fixtures'
const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../../../../telemetry/client', () => ({
  track: trackMock
}))

vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Fork 6d65165647: remote-relay and terminal-title Claude/Codex status is refused without
// attestation, so these relays and OSC repaints neither create nor change a Claude row.

describe('AgentHookServer ingestTerminalStatus', () => {
  it('preserves a hook turn stamp when an OSC repaint omits hook-only completion text', () => {
    const server = attestFixtureHookContext(new AgentHookServer())
    const listener = vi.fn()
    server.setListener(listener)

    server.ingestRemote(
      {
        paneKey: PANE,
        payload: { state: 'working', prompt: 'review the PR', agentType: 'claude' }
      },
      'conn-1'
    )
    listener.mockClear()
    server.ingestRemote(
      {
        paneKey: PANE,
        payload: {
          state: 'working',
          prompt: 'review the PR',
          agentType: 'claude',
          lastAssistantMessage: 'Review complete.',
          turnCompletedAt: 1_700_000_005_000
        }
      },
      'conn-1'
    )
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: 'conn-1',
      payload: { state: 'working', prompt: 'review the PR', agentType: 'claude' }
    })
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: 'conn-1',
      payload: { state: 'done', prompt: 'review the PR', agentType: 'claude' }
    })

    expect(listener).not.toHaveBeenCalled()
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getContextIntegrityRejections()).toEqual({
      remote_context_attestation_unavailable: 2,
      terminal_context_attestation_unavailable: 2
    })
  })

  it('accepts an identical-prompt hook boundary after a stamped turn', () => {
    const server = attestFixtureHookContext(new AgentHookServer())
    const listener = vi.fn()
    server.setListener(listener)

    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'Stop',
        payload: {
          state: 'working',
          prompt: 'check status',
          agentType: 'claude',
          turnCompletedAt: 1_700_000_005_000
        }
      },
      'conn-1'
    )
    server.ingestRemote(
      {
        paneKey: PANE,
        hookEventName: 'UserPromptSubmit',
        payload: { state: 'working', prompt: 'check status', agentType: 'claude' }
      },
      'conn-1'
    )

    expect(listener).not.toHaveBeenCalled()
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getContextIntegrityRejections()).toEqual({
      remote_context_attestation_unavailable: 2
    })
  })

  // OSC lacks provider session identity; overwriting it would break mobile transcript subscriptions after restart.

  // Missing or unknown OSC agent identity cannot contradict the cached provider session.

  // Claude reports hookless slash commands (`/context`) as OSC 7501 working then done; the session lives on (#36033).
  it('keeps the cached provider session when an OSC status starts a turn after done', () => {
    const server = attestFixtureHookContext(new AgentHookServer())
    const providerSession = { key: 'session_id' as const, id: 'claude-session-1' }

    server.ingestRemote(
      {
        paneKey: PANE,
        providerSession,
        payload: { state: 'done', prompt: 'first', agentType: 'claude' }
      },
      'conn-1'
    )
    for (const state of ['working', 'done'] as const) {
      server.ingestTerminalStatus({
        paneKey: PANE,
        connectionId: 'conn-1',
        payload: { state, prompt: '', agentType: 'claude' }
      })
    }

    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getProviderSessionIdentities()).toEqual([])
    expect(server.getContextIntegrityRejections()).toEqual({
      remote_context_attestation_unavailable: 1,
      terminal_context_attestation_unavailable: 2
    })
  })

  it('drops the cached provider session when a relaunched agent starts a turn after the old one exited', () => {
    const server = attestFixtureHookContext(new AgentHookServer())

    server.ingestRemote(
      {
        paneKey: PANE,
        providerSession: { key: 'session_id' as const, id: 'claude-session-1' },
        payload: { state: 'done', prompt: 'first', agentType: 'claude' }
      },
      'conn-1'
    )
    server.reconcileEndedProcessForPaneKeys([PANE], { preserveResumeIdentity: true })
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: 'conn-1',
      payload: { state: 'working', prompt: '', agentType: 'claude' }
    })

    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getProviderSessionIdentities()).toEqual([])
    expect(server.getContextIntegrityRejections()).toEqual({
      remote_context_attestation_unavailable: 1,
      terminal_context_attestation_unavailable: 1
    })
  })
})

describe('the main agent fact across an OSC repaint', () => {
  it('carries the hook row main agent while OSC repaints the same state, and drops it on a state edge', () => {
    const server = attestFixtureHookContext(new AgentHookServer())
    server.ingestRemote(
      {
        paneKey: PANE,
        source: 'claude',
        hookEventName: 'Stop',
        payload: {
          state: 'working',
          workingMode: 'monitoring',
          prompt: 'watch the build',
          agentType: 'claude',
          mainAgent: { state: 'done', stateStartedAt: 10 }
        }
      },
      'conn-1'
    )
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: 'conn-1',
      payload: {
        state: 'working',
        prompt: 'watch the build',
        agentType: 'claude',
        toolName: 'Bash'
      }
    })
    server.ingestTerminalStatus({
      paneKey: PANE,
      connectionId: 'conn-1',
      payload: { state: 'done', prompt: 'watch the build', agentType: 'claude' }
    })

    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getContextIntegrityRejections()).toEqual({
      remote_context_attestation_unavailable: 1,
      terminal_context_attestation_unavailable: 2
    })
  })
})
