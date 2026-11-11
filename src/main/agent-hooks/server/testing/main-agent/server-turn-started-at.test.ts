import { readSavedStatus } from '../persistence/last-status.test-fixtures'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, postHookEvent, PANE } from '../server.test-fixtures'

import { attestFixtureHookContext } from '../attested-hook-context.test-fixtures'
const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../../../../telemetry/client', () => ({ track: trackMock }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

beforeEach(() => {
  _internals.resetCachesForTests()
  getCohortAtEmitMock.mockReturnValue({})
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Separate host timestamps by advancing real time between events.
async function nextMillisecond(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 5))
}

// Host-stamped turn starts survive reader reloads without reconstructing state history.
describe('the host-stamped turn start', () => {
  const servers: AgentHookServer[] = []
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-turn-started-at-'))
  })

  afterEach(() => {
    for (const server of servers) {
      server.stop()
    }
    servers.length = 0
    rmSync(userDataPath, { recursive: true, force: true })
  })

  async function startServer(): Promise<AgentHookServer> {
    const server = attestFixtureHookContext(new AgentHookServer())
    servers.push(server)
    await server.start({ env: 'production', userDataPath })
    return server
  }

  async function post(server: AgentHookServer, payload: Record<string, unknown>): Promise<void> {
    const response = await postHookEvent(server, buildBody(payload))
    expect(response.status).toBe(204)
    await nextMillisecond()
  }

  function turnStartedAt(server: AgentHookServer): number | undefined {
    return server.getStatusSnapshot()[0]?.turnStartedAt
  }

  it('is not stamped by a child agent, and the same prompt sent again is a new turn', async () => {
    const server = await startServer()
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'Rename the module' })
    const started = turnStartedAt(server)

    await post(server, {
      hook_event_name: 'UserPromptSubmit',
      prompt: 'child task',
      agent_id: 'child-1'
    })
    expect(turnStartedAt(server)).toBe(started)

    // Esc at a permission prompt fires no hook, so the resend follows the stale wait directly.
    await post(server, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {} })
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'Rename the module' })
    expect(turnStartedAt(server)).toBeGreaterThan(started!)
  })

  // Fork 6d65165647: relayed and terminal-title Claude/Codex status is refused without
  // attestation, so neither path can stamp or drop a turn start.
  it('is not stamped by a relayed replay', async () => {
    const server = await startServer()
    const envelope = {
      paneKey: PANE,
      tabId: 'tab-1',
      source: 'claude' as const,
      hookEventName: 'UserPromptSubmit',
      payload: { state: 'working' as const, prompt: 'relayed', agentType: 'claude' as const }
    }
    server.ingestRemote(envelope, 'ssh-turn')
    server.ingestRemote({ ...envelope, isReplay: true }, 'ssh-turn')
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getContextIntegrityRejections()).toMatchObject({
      remote_context_attestation_unavailable: 2
    })
  })

  // An OSC repaint can land before the prompt hook; it must not reopen the finished turn.
  it('drops the stamp when a finished main agent runs again with no turn-opening event', async () => {
    const server = await startServer()
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'Rename the module' })
    await post(server, { hook_event_name: 'Stop' })
    const started = turnStartedAt(server)
    expect(started).toEqual(expect.any(Number))

    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: 'Rename the module', agentType: 'claude' }
    })
    expect(server.getStatusSnapshot()[0]).toMatchObject({ state: 'done', turnStartedAt: started })
    expect(server.getContextIntegrityRejections()).toMatchObject({
      terminal_context_attestation_unavailable: 1
    })
  })

  it('reaches the live push and survives a restart through the status file', async () => {
    const server = await startServer()
    const pushed: (number | undefined)[] = []
    server.setListener((status) => pushed.push(status.turnStartedAt))
    await post(server, { hook_event_name: 'UserPromptSubmit', prompt: 'Rename the module' })
    await post(server, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} })
    const started = turnStartedAt(server)
    expect(pushed.at(-1)).toBe(started)
    server.flushStatusPersistSync()
    server.stop()
    const file = JSON.parse(readSavedStatus(join(userDataPath, 'agent-hooks', 'last-status.json')))
    expect(file.entries[PANE].turnStartedAt).toBe(started)

    const restarted = await startServer()
    expect(restarted.getStatusSnapshot()[0]).toMatchObject({
      restoredUnconfirmed: true,
      turnStartedAt: started
    })
    await post(restarted, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} })
    expect(turnStartedAt(restarted)).toBe(started)
  })
})
