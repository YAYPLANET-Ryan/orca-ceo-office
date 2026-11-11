// Round-trip real relay HTTP hooks through the in-memory SSH dispatcher/multiplexer to main’s agent-status listener.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SshChannelMultiplexer } from '../main/ssh/protocol/ssh-channel-multiplexer'
import type { MultiplexerTransport } from '../main/ssh/protocol/ssh-multiplexer-transport-writer'
import { RelayDispatcher } from './dispatcher'
import { RelayAgentHookServer } from './agent-hook-server'
import {
  AGENT_HOOK_NOTIFICATION_METHOD,
  AGENT_HOOK_REQUEST_REPLAY_METHOD
} from '../shared/agent-hook-listener/transport/agent-hook-relay'
import { AgentHookServer } from '../main/agent-hooks/server/agent-hook-server'
import { publishAgentHookEnvelope } from './agent-hook-envelope-publication'

import { attestFixtureHookContext } from '../main/agent-hooks/server/testing/attested-hook-context.test-fixtures'
const LEAF_7 = '77777777-7777-4777-8777-777777777777'
const LEAF_9 = '99999999-9999-4999-8999-999999999999'
// Fork 6d65165647: relay Claude/Codex status is refused without attestation.
const REMOTE_REFUSAL = 'remote_context_attestation_unavailable'

describe('Integration: relay hook server → mux → AgentHookServer.ingestRemote', () => {
  let tmpDir: string
  let mux: SshChannelMultiplexer
  let dispatcher: RelayDispatcher
  let hookServer: RelayAgentHookServer
  let orcaServer: AgentHookServer
  const refusals = (): number => orcaServer.getContextIntegrityRejections()[REMOTE_REFUSAL] ?? 0

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agent-hook-e2e-'))

    let relayFeedFn: ((data: Buffer) => void) | undefined
    const clientDataCallbacks: ((data: Buffer) => void)[] = []

    const clientTransport: MultiplexerTransport = {
      write: (data: Buffer) => {
        setImmediate(() => relayFeedFn?.(data))
      },
      onData: (cb) => {
        clientDataCallbacks.push(cb)
      },
      // No transport close is simulated; satisfy the required callback registration without retaining listeners.
      onClose: () => {}
    }

    dispatcher = new RelayDispatcher(
      (data: Buffer) => {
        setImmediate(() => {
          for (const cb of clientDataCallbacks) {
            cb(data)
          }
        })
      },
      {
        writableHighWaterMark: () => 4096,
        writableLength: () => 0
      }
    )
    relayFeedFn = (data: Buffer) => dispatcher.feed(data)

    hookServer = new RelayAgentHookServer({
      endpointDir: tmpDir,
      forward: (envelope) => {
        publishAgentHookEnvelope(dispatcher, envelope)
      }
    })
    await hookServer.start()

    dispatcher.onRequest(AGENT_HOOK_REQUEST_REPLAY_METHOD, async () => {
      const replayed = hookServer.replayCachedPayloadsForPanes()
      return { replayed }
    })

    mux = new SshChannelMultiplexer(clientTransport)

    orcaServer = attestFixtureHookContext(new AgentHookServer())
    // Main receives through ingestRemote; only the relay starts an HTTP listener.
    mux.onNotification((method, params) => {
      if (method === AGENT_HOOK_NOTIFICATION_METHOD) {
        orcaServer.ingestRemote(
          params as unknown as {
            paneKey: string
            tabId?: string
            worktreeId?: string
            payload: unknown
          },
          'conn-test'
        )
      }
    })
  })

  afterEach(async () => {
    mux.dispose()
    dispatcher.dispose()
    hookServer.stop()
    orcaServer.stop()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('publishes a title-confirmed Claude Escape from the execution host and replays it on reconnect', async () => {
    const paneKey = `tab-7:${LEAF_7}`
    const { port, token } = hookServer.getCoordinates()
    const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({
        paneKey,
        tabId: 'tab-7',
        worktreeId: 'folder-workspace',
        env: 'remote',
        version: '1',
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'long table' }
      })
    })
    expect(response.status).toBe(204)
    await expect.poll(refusals).toBe(1)
    expect(orcaServer.getStatusSnapshotForPane(paneKey)).toEqual([])
    const native = hookServer.claudeTerminalInterrupts
    native.observe(paneKey, { kind: 'title', title: '◐ Long table' })
    native.observe(paneKey, { kind: 'input', data: '\x1b' })
    native.observe(paneKey, { kind: 'title', title: '◑ Long table' })
    native.observe(paneKey, { kind: 'input', data: '\x1b' })
    native.observe(paneKey, { kind: 'title', title: '✳ Long table' })
    // The execution host still publishes the confirmed cancellation; main refuses it as well.
    await expect.poll(refusals).toBe(2)
    expect(orcaServer.getStatusSnapshotForPane(paneKey)).toEqual([])
    const replayedPanes: string[] = []
    orcaServer.setListener((event) => replayedPanes.push(event.paneKey))
    expect(hookServer.replayCachedPayloadsForPanes()).toBe(1)
    await expect.poll(refusals).toBe(3)
    expect(replayedPanes).toEqual([])
    expect(orcaServer.getStatusSnapshotForPane(paneKey)).toEqual([])
  })

  it.each([0, 1, 2, 3])(
    'delivers Cursor form payloads with %i BOMs to the host-owned status store',
    async (count) => {
      const { port, token } = hookServer.getCoordinates()
      for (const [hookEventName, state] of [
        ['beforeSubmitPrompt', 'working'],
        ['stop', 'done']
      ]) {
        const payload = Buffer.concat([
          ...Array.from({ length: count }, () => Buffer.from([0xef, 0xbb, 0xbf])),
          Buffer.from(
            JSON.stringify({
              hook_event_name: hookEventName,
              prompt: 'Synthetic café 😀',
              status: 'completed'
            })
          )
        ])
        const response = await fetch(`http://127.0.0.1:${port}/hook/cursor`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Orca-Agent-Hook-Token': token
          },
          body: new URLSearchParams({
            paneKey: `tab-7:${LEAF_7}`,
            worktreeId: 'folder:synthetic-cursor',
            payload: payload.toString('utf8')
          }).toString()
        })
        expect(response.status).toBe(204)
        await expect
          .poll(() => orcaServer.getStatusSnapshot())
          .toEqual([
            expect.objectContaining({
              paneKey: `tab-7:${LEAF_7}`,
              worktreeId: 'folder:synthetic-cursor',
              connectionId: 'conn-test',
              state,
              agentType: 'cursor',
              prompt: 'Synthetic café 😀'
            })
          ])
      }
    }
  )

  it('acknowledges malformed Cursor form payloads without publishing status', async () => {
    const { port, token } = hookServer.getCoordinates()
    for (const payload of [
      '',
      '\uFEFF\uFEFFnot json',
      ' \uFEFF{}',
      '{\uFEFF"hook_event_name":"stop"}',
      '\uFEFF\uFEFF{"hook_event_name":"unknown"}'
    ]) {
      const response = await fetch(`http://127.0.0.1:${port}/hook/cursor`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Orca-Agent-Hook-Token': token
        },
        body: new URLSearchParams({ paneKey: `tab-7:${LEAF_7}`, payload }).toString()
      })
      expect(response.status).toBe(204)
    }
    await new Promise((resolve) => setImmediate(resolve))
    expect(hookServer.replayCachedPayloadsForPanes()).toBe(0)
    expect(orcaServer.getStatusSnapshot()).toEqual([])
  })

  it('clears remote Claude permission when the approved tool starts with matching identity', async () => {
    const { port, token } = hookServer.getCoordinates()
    const postClaude = async (payload: Record<string, unknown>): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: `tab-7:${LEAF_7}`,
          tabId: 'tab-7',
          worktreeId: 'wt-7',
          env: 'remote',
          version: '1',
          payload
        })
      })

    await expect(
      postClaude({
        hook_event_name: 'PermissionRequest',
        agent_id: 'agent-subagent-a',
        agent_type: 'Review',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' }
      })
    ).resolves.toMatchObject({ status: 204 })
    await expect.poll(refusals).toBe(1)
    expect(orcaServer.getStatusSnapshot()).toEqual([])
    await expect(
      postClaude({
        hook_event_name: 'PreToolUse',
        agent_id: 'agent-subagent-a',
        agent_type: 'Review',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test' },
        tool_use_id: 'toolu-approved-remote'
      })
    ).resolves.toMatchObject({ status: 204 })

    await expect.poll(refusals).toBe(2)
    expect(orcaServer.getStatusSnapshot()).toEqual([])
  })

  it('clears remote Claude permission when its teammate idles', async () => {
    const { port, token } = hookServer.getCoordinates()
    const postClaude = (payload: Record<string, unknown>): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: `tab-9:${LEAF_9}`,
          tabId: 'tab-9',
          worktreeId: 'wt-9',
          env: 'remote',
          version: '1',
          payload
        })
      })

    await postClaude({
      hook_event_name: 'PermissionRequest',
      agent_id: 'areviewer-6d3cb5b5',
      agent_type: 'reviewer',
      tool_name: 'Bash',
      tool_input: { command: 'false' }
    })
    await expect.poll(refusals).toBe(1)
    expect(orcaServer.getStatusSnapshot()).toEqual([])
    await postClaude({ hook_event_name: 'TeammateIdle', teammate_name: 'reviewer' })

    await expect.poll(refusals).toBe(2)
    expect(orcaServer.getStatusSnapshot()).toEqual([])
  })

  it('clears remote Claude permission when approved PostToolUse matches the preceding tool use id', async () => {
    const { port, token } = hookServer.getCoordinates()
    const postClaude = async (payload: Record<string, unknown>): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': token
        },
        body: JSON.stringify({
          paneKey: `tab-7:${LEAF_7}`,
          tabId: 'tab-7',
          worktreeId: 'wt-7',
          env: 'remote',
          version: '1',
          payload
        })
      })

    await expect(
      postClaude({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/orca-2824-permission-target' },
        tool_use_id: 'toolu-approved-remote-post'
      })
    ).resolves.toMatchObject({ status: 204 })
    await expect(
      postClaude({
        hook_event_name: 'PermissionRequest',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/orca-2824-permission-target' }
      })
    ).resolves.toMatchObject({ status: 204 })
    await expect.poll(refusals).toBe(2)
    expect(orcaServer.getStatusSnapshot()).toEqual([])
    await expect(
      postClaude({
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'rm -rf /tmp/orca-2824-permission-target' },
        tool_use_id: 'toolu-approved-remote-post'
      })
    ).resolves.toMatchObject({ status: 204 })

    await expect.poll(refusals).toBe(3)
    expect(orcaServer.getStatusSnapshot()).toEqual([])
  })

  it('replays the cached last-status on agent_hook.requestReplay', async () => {
    // Listen before POST so synchronous cache replay cannot masquerade as an SSH round-trip.
    const events: { paneKey: string; payload: unknown }[] = []
    orcaServer.setListener((event) => {
      events.push({ paneKey: event.paneKey, payload: event.payload })
    })

    const { port, token } = hookServer.getCoordinates()
    await fetch(`http://127.0.0.1:${port}/hook/claude`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': token
      },
      body: JSON.stringify({
        paneKey: `tab-9:${LEAF_9}`,
        payload: { hook_event_name: 'UserPromptSubmit', prompt: 'cached' }
      })
    })

    // Await the live refusal before requesting replay so the next refusal proves a second notification.
    await expect.poll(refusals).toBe(1)
    expect(events).toEqual([])

    const result = (await mux.request(AGENT_HOOK_REQUEST_REPLAY_METHOD)) as {
      replayed: number
    }
    expect(result.replayed).toBe(1)

    // The replayed envelope crosses SSH and is refused again, rather than only incrementing relay state.
    await expect.poll(refusals).toBe(2)
    expect(events).toEqual([])
    expect(orcaServer.getStatusSnapshot()).toEqual([])
  })
})
