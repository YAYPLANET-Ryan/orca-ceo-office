import { describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../../shared/agent-status/contracts/agent-status-freshness'
import { selectFreshExplicitAgentStatus } from '../../../../runtime/workspaces/process-listing/runtime-hook-agent-row-selection'
import { wslHookRelayConnectionId } from '../../../../../shared/wsl-hook-relay-contract'

import { attestFixtureHookContext } from '../attested-hook-context.test-fixtures'
const PANE_KEY = 'tab-handle:33333333-3333-4333-8333-333333333333'
const HANDLE = 'term_identity'
const NEW_PANE_KEY = 'tab-reminted:44444444-4444-4444-8444-444444444444'
// Fork 6d65165647: terminal-title and relay Claude/Codex status is refused without attestation;
// these handle-stamping tests use an unprotected agent (gemini) because no assertion is
// agent-specific.
const AGENT = 'gemini'

function ingest(server: AgentHookServer, overrides: Record<string, unknown> = {}): void {
  server.ingestTerminalStatus({
    paneKey: PANE_KEY,
    tabId: 'tab-handle',
    worktreeId: 'worktree',
    connectionId: null,
    terminalHandle: HANDLE,
    payload: { state: 'working', prompt: 'ship it', agentType: AGENT },
    ...overrides
  })
}

describe('the terminal handle a status row is stamped with', () => {
  it('does not cross a connection ownership change on a colliding pane key', () => {
    const server = attestFixtureHookContext(new AgentHookServer())
    ingest(server, { connectionId: 'ssh-a' })

    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        tabId: 'tab-handle',
        worktreeId: 'other-worktree',
        payload: { state: 'done', prompt: 'other host', agentType: AGENT }
      },
      'ssh-b'
    )

    expect(server.getStatusSnapshot()[0]).toMatchObject({
      connectionId: 'ssh-b',
      worktreeId: 'other-worktree'
    })
    expect(server.getStatusSnapshot()[0]).not.toHaveProperty('terminalHandle')
  })

  it('moves one PTY row and all of its resume identity across a pane remint', () => {
    const server = attestFixtureHookContext(new AgentHookServer())
    ingest(server)
    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        tabId: 'tab-handle',
        worktreeId: 'worktree',
        providerSession: { key: 'session_id', id: 'session-1' },
        payload: { state: 'working', prompt: 'ship it', agentType: AGENT }
      },
      null
    )
    // A relayed provider session is refused without attestation for any agent, so the row moved
    // below carries the PTY's handle but no resume identity.
    expect(server.getContextIntegrityRejections()).toEqual({
      remote_context_attestation_unavailable: 1
    })
    expect(server.getProviderSessionIdentities()).toEqual([])
    const mutations: Parameters<Parameters<typeof server.subscribeStatusRowMutations>[0]>[0][] = []
    server.subscribeStatusRowMutations((mutation) => mutations.push(mutation))

    ingest(server, { paneKey: NEW_PANE_KEY, tabId: 'tab-reminted' })

    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: NEW_PANE_KEY, terminalHandle: HANDLE })
    ])
    expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
    expect(mutations).toEqual([
      {
        before: { paneKey: PANE_KEY, worktreeId: 'worktree', terminalHandle: HANDLE },
        after: { paneKey: NEW_PANE_KEY, worktreeId: 'worktree', terminalHandle: HANDLE }
      }
    ])

    server.dropStatusEntry(NEW_PANE_KEY)
    // With no resume identity to retain, dropping the row removes it and its handle outright.
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.reconcileEndedProcessForPaneKeys([NEW_PANE_KEY])).toBe(0)
    expect(mutations).toHaveLength(2)
    expect(
      (server as unknown as { paneKeyByTerminalHandle: Map<string, string> })
        .paneKeyByTerminalHandle
    ).toEqual(new Map())
  })

  it('preserves a local WSL terminal join only for its exact relay distro', () => {
    const server = attestFixtureHookContext(new AgentHookServer())
    const worktreeId = String.raw`repo::\\wsl.localhost\Ubuntu\home\user\repo`
    ingest(server, { worktreeId })

    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        tabId: 'tab-handle',
        worktreeId,
        providerSession: { key: 'session_id', id: 'wsl-session' },
        payload: { state: 'working', prompt: 'ship it', agentType: AGENT }
      },
      wslHookRelayConnectionId('Ubuntu')
    )
    // The relayed provider session is refused, so the local PTY row keeps its handle unchanged.
    expect(server.getContextIntegrityRejections()).toEqual({
      remote_context_attestation_unavailable: 1
    })
    expect(server.getStatusSnapshot()[0]).toMatchObject({ terminalHandle: HANDLE })
    expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()

    server.ingestRemote(
      {
        paneKey: PANE_KEY,
        tabId: 'tab-handle',
        worktreeId,
        payload: { state: 'done', prompt: 'wrong distro', agentType: AGENT }
      },
      wslHookRelayConnectionId('Debian')
    )
    expect(server.getStatusSnapshot()[0]).not.toHaveProperty('terminalHandle')
  })

  it('renews duplicate OSC evidence without publishing another semantic row', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    try {
      const server = attestFixtureHookContext(new AgentHookServer())
      const enriched = vi.fn()
      const mutated = vi.fn()
      const statusChanges = vi.fn()
      server.subscribeEnrichedStatus(enriched)
      server.subscribeStatusRowMutations(mutated)
      server.subscribeStatusChanges(statusChanges)
      ingest(server)
      enriched.mockClear()
      mutated.mockClear()
      statusChanges.mockClear()

      vi.setSystemTime(1_000 + AGENT_STATUS_STALE_AFTER_MS + 1)
      ingest(server)

      const [row] = server.getStatusSnapshot()
      expect(row.evidenceObservedAt).toBe(Date.now())
      expect(
        selectFreshExplicitAgentStatus({ handle: HANDLE, paneKey: PANE_KEY, hookRows: [row] })
      ).toMatchObject({ status: 'working', updatedAt: Date.now() })
      expect(enriched).not.toHaveBeenCalled()
      expect(mutated).not.toHaveBeenCalled()
      expect(statusChanges).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
