import { describe, expect, it } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { wslHookRelayConnectionId } from '../../../../../shared/wsl-hook-relay-contract'

import { attestFixtureHookContext } from '../attested-hook-context.test-fixtures'
const PANE_KEY = 'tab-handle:33333333-3333-4333-8333-333333333333'
const HANDLE = 'term_identity'
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
})
