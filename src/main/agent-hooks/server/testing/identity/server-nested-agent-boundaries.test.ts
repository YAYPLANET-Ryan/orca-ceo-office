import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'

import { attestFixtureHookContext } from '../attested-hook-context.test-fixtures'
vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

const route = { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1' }

// Fork 6d65165647: relayed Claude/Codex status is refused without attestation, so no relayed
// owner row exists for a nested provider to be scoped against or to replace.
function expectRefused(server: AgentHookServer, count: number): void {
  expect(server.getStatusSnapshot()).toEqual([])
  expect(server.getContextIntegrityRejections()).toEqual({
    remote_context_attestation_unavailable: count
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('nested provider ownership boundaries', () => {
  it.each([
    ['ssh-b', 'wt-1', 'codex'],
    ['conn-1', 'wt-2', 'codex'],
    ['conn-1', 'wt-1', 'claude']
  ] as const)(
    'scopes ownership to host %s and workspace %s',
    (connectionId, worktreeId, _agent) => {
      const server = attestFixtureHookContext(new AgentHookServer())
      server.ingestRemote(
        { ...route, payload: { state: 'working', prompt: 'Parent', agentType: 'claude' } },
        'conn-1'
      )
      server.ingestRemote(
        {
          ...route,
          worktreeId,
          payload: { state: 'working', prompt: 'Other', agentType: 'codex' }
        },
        connectionId
      )
      expectRefused(server, 2)
    }
  )

  it.each([
    [null, 'wsl:Ubuntu'],
    ['wsl:Ubuntu', null]
  ] as const)('retains WSL ownership across %s to %s transport', (before, after) => {
    const server = attestFixtureHookContext(new AgentHookServer())
    const worktreeId = 'repo:://wsl.localhost/Ubuntu/home/user/project'
    server.ingestRemote(
      {
        ...route,
        worktreeId,
        payload: { state: 'working', prompt: 'Parent', agentType: 'claude' }
      },
      before
    )
    server.ingestRemote(
      { ...route, worktreeId, payload: { state: 'working', prompt: 'Nested', agentType: 'codex' } },
      after
    )
    expectRefused(server, 2)
  })

  it('admits a local HTTP owner despite a remote pane-key collision', async () => {
    const server = attestFixtureHookContext(new AgentHookServer())
    await server.start({ env: 'production' })
    try {
      server.ingestRemote(
        { ...route, payload: { state: 'working', prompt: 'Remote', agentType: 'claude' } },
        'ssh-a'
      )
      const response = await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'local-codex',
          prompt: 'Local'
        }),
        '/hook/codex'
      )
      expect(response.status).toBe(204)
      // The relayed Claude collision is refused; the attested local Codex hook still owns the pane.
      expect(server.getContextIntegrityRejections()).toEqual({
        remote_context_attestation_unavailable: 1
      })
      expect(server.getStatusSnapshot()).toHaveLength(1)
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        connectionId: null,
        agentType: 'codex',
        prompt: 'Local',
        providerSession: { id: 'local-codex' }
      })
    } finally {
      server.stop()
    }
  })

  it('keeps nested Pi identity-only metadata off an active owner and permits it after completion', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const server = attestFixtureHookContext(new AgentHookServer())
    server.ingestRemote(
      {
        ...route,
        payload: { state: 'working', prompt: 'Parent work', agentType: 'claude' },
        providerSession: { key: 'session_id', id: 'claude-parent' }
      },
      'conn-1'
    )
    expectRefused(server, 1)
    const pi = {
      ...route,
      providerSessionOnly: true,
      providerSession: {
        key: 'session_id' as const,
        id: 'pi-child',
        transcriptPath: '/tmp/pi-child.jsonl'
      },
      payload: { state: 'done' as const, prompt: '', agentType: 'pi' as const }
    }
    // A relayed provider session is refused too, whatever the agent.
    server.ingestRemote(pi, 'conn-1')
    expectRefused(server, 2)
    server.ingestRemote(
      { ...route, payload: { state: 'done', prompt: 'Parent work', agentType: 'claude' } },
      'conn-1'
    )
    server.ingestRemote(pi, 'conn-1')
    expectRefused(server, 4)
  })
})
