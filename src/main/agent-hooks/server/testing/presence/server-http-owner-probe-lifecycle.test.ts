import { afterEach, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, postHookEvent } from '../server.test-fixtures'
import type { probeAgentProcessPresence } from '../../../../../shared/agent-status/process/agent-process-presence-probe'

import { attestFixtureHookContext } from '../attested-hook-context.test-fixtures'
vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>(async () => 'live'))
vi.mock('../../../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: probe
}))
const servers: AgentHookServer[] = []

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  probe.mockReset().mockResolvedValue('live')
})

// Fork 6d65165647: Claude/Codex hooks are admitted by root evidence and skip the HTTP owner probe,
// so this suite drives the probe with unprotected agents: an idle Antigravity owner and Grok
// challengers. No assertion depends on Claude/Codex behaviour.
async function idleOwner(server: AgentHookServer, session = 'agy-parent'): Promise<void> {
  for (const [hook_event_name, extra] of [
    ['PreInvocation', {}],
    ['Stop', { fullyIdle: true, terminationReason: 'NO_TOOL_CALL', error: '' }]
  ] as const) {
    await postHookEvent(
      server,
      buildBody(
        { hook_event_name, conversationId: session, prompt: session, ...extra },
        {
          agentProcess: JSON.stringify({ pid: 4001, platform: 'linux', startTime: 'birth' })
        }
      ),
      '/hook/antigravity'
    )
  }
}

it.each(['stop', 'restart', 'disable', 're-enable'] as const)(
  'discards an old hook when %s interrupts its owner probe',
  async (action) => {
    const server = attestFixtureHookContext(new AgentHookServer())
    servers.push(server)
    await server.start({ env: 'production' })
    await idleOwner(server)
    let release: (() => void) | undefined
    probe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve('exited')
        })
    )
    const pending = postHookEvent(
      server,
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'obsolete-grok',
        prompt: 'Obsolete turn'
      }),
      '/hook/grok'
    )
    await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
    if (action === 'stop' || action === 'restart') {
      server.stop()
      if (action === 'restart') {
        await server.start({ env: 'production' })
        await idleOwner(server, 'replacement-agy')
      }
    } else {
      server.setStatusHooksEnabled(false)
      if (action === 're-enable') {
        server.setStatusHooksEnabled(true)
      }
    }
    const before = server.getStatusSnapshot()
    const changed = vi.fn()
    const emitted = vi.fn()
    server.subscribeStatusChanges(changed)
    server.setListener(emitted)
    emitted.mockClear()
    release?.()
    expect((await pending).status).toBe(204)
    expect(server.getStatusSnapshot()).toEqual(before)
    expect(changed).not.toHaveBeenCalled()
    expect(emitted).not.toHaveBeenCalled()
    if (action === 'restart' || action === 're-enable') {
      probe.mockResolvedValue('exited')
      await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'current-grok',
          prompt: 'Current turn'
        }),
        '/hook/grok'
      )
      expect(server.getStatusSnapshot()[0]).toMatchObject({
        agentType: 'grok',
        providerSession: { id: 'current-grok' }
      })
    }
  }
)

it('starts a new owner check after re-enabling without waiting on the discarded generation', async () => {
  const server = attestFixtureHookContext(new AgentHookServer())
  servers.push(server)
  await server.start({ env: 'production' })
  await idleOwner(server)
  let release: (() => void) | undefined
  probe.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve('live')
      })
  )
  const postGrok = (session: string) =>
    postHookEvent(
      server,
      buildBody({ hook_event_name: 'UserPromptSubmit', session_id: session, prompt: session }),
      '/hook/grok'
    )
  const obsolete = postGrok('obsolete-grok')
  await vi.waitFor(() => expect(probe).toHaveBeenCalledOnce())
  server.setStatusHooksEnabled(false)
  server.setStatusHooksEnabled(true)
  probe.mockResolvedValue('exited')
  const current = postGrok('current-grok')
  try {
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(2))
    expect((await current).status).toBe(204)
    expect(server.getStatusSnapshot()[0].providerSession?.id).toBe('current-grok')
  } finally {
    release?.()
    await Promise.all([obsolete, current])
  }
  expect(server.getStatusSnapshot()[0].providerSession?.id).toBe('current-grok')
})
