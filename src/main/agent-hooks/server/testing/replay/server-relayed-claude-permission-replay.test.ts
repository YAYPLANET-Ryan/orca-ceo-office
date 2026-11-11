// Replay captured SSH permission hooks; single-row relay caching can hide the resolving event during disconnect.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RelayAgentHookServer } from '../../../../../wsl-guest/agent-hook-server'
import type { AgentHookRelayEnvelope } from '../../../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, PANE } from '../server.test-fixtures'
import { hookAt, loadCapture } from '../interruptions/claude-cancel-capture.test-fixture'
import selfDenied from '../../../../claude/__fixtures__/claude-self-denied-permission-hooks.json'

import { attestFixtureHookContext } from '../attested-hook-context.test-fixtures'
const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(),
  trackMock: vi.fn()
}))

vi.mock('../../../../telemetry/client', () => ({ track: trackMock }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

const records = loadCapture('claude-permission-approve-deny-hooks')
const prompt = hookAt(records, 0).payload
const firstTool = hookAt(records, 1).payload
const firstPermission = hookAt(records, 2).payload
const firstNotification = hookAt(records, 3).payload
const firstToolDone = hookAt(records, 4).payload
const secondTool = hookAt(records, 5).payload

const temporaryPaths: string[] = []
const running: { stop: () => void }[] = []

beforeEach(() => {
  _internals.resetCachesForTests()
  trackMock.mockReset()
  getCohortAtEmitMock.mockReset()
  getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
})

afterEach(() => {
  for (const server of running.splice(0)) {
    server.stop()
  }
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

type SshPane = {
  relay: RelayAgentHookServer
  desktop: AgentHookServer
  connected: boolean
  forwarded: AgentHookRelayEnvelope[]
  /** Envelopes the desktop was handed; each is refused (see expectRefused). */
  ingested: number
  post: (payload: Record<string, unknown>) => Promise<void>
}

async function startSshPane(): Promise<SshPane> {
  const endpointDir = mkdtempSync(join(tmpdir(), 'orca-relayed-permission-'))
  temporaryPaths.push(endpointDir)
  const pane: SshPane = {
    desktop: attestFixtureHookContext(new AgentHookServer()),
    connected: true,
    forwarded: [],
    ingested: 0,
    relay: new RelayAgentHookServer({
      endpointDir,
      token: 'relayed-permission-token',
      forward: (envelope) => {
        pane.forwarded.push(envelope)
        if (pane.connected) {
          pane.ingested += 1
          pane.desktop.ingestRemote(envelope, 'conn-1')
        }
      }
    }),
    post: async (payload) => {
      const { port, token } = pane.relay.getCoordinates()
      const response = await fetch(`http://127.0.0.1:${port}/hook/claude`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify(buildBody(payload))
      })
      expect(response.status).toBe(204)
    }
  }
  running.push(pane.relay, pane.desktop)
  await pane.relay.start({ publishEndpoint: false })
  return pane
}

async function postAll(pane: SshPane, payloads: Record<string, unknown>[]): Promise<void> {
  for (const payload of payloads) {
    await pane.post(payload)
  }
}

// Fork 6d65165647: relayed Claude/Codex status is refused without attestation. The relay's own
// replay envelopes are still asserted; the desktop refuses every one of them and keeps no row.
function expectRefused(pane: SshPane): void {
  expect(pane.ingested).toBeGreaterThan(0)
  expect(pane.desktop.getStatusSnapshotForPane(PANE)).toEqual([])
  expect(pane.desktop.getContextIntegrityRejections()).toEqual({
    remote_context_attestation_unavailable: pane.ingested
  })
}

async function waitingOnFirstRequest(): Promise<SshPane> {
  const pane = await startSshPane()
  await postAll(pane, [prompt, firstTool, firstPermission, firstNotification])
  expectRefused(pane)
  return pane
}

function reconnect(pane: SshPane): void {
  pane.connected = true
  pane.relay.replayCachedPayloadsForPanes()
}

describe('a relayed Claude permission wait across a reconnect (captured)', () => {
  it('clears on reconnect when the request ended while the desktop was away', async () => {
    const pane = await waitingOnFirstRequest()
    pane.connected = false
    await postAll(pane, [firstToolDone, secondTool])
    reconnect(pane)

    expectRefused(pane)
    const replay = pane.forwarded.at(-1)
    expect(replay).toMatchObject({
      isReplay: true,
      hookEventName: 'PreToolUse',
      claudeSettledRequests: [{ toolUseId: firstToolDone.tool_use_id }]
    })
  })

  it('keeps the wait when the request the desktop shows has not ended', async () => {
    const pane = await waitingOnFirstRequest()
    pane.connected = false
    // A different tool's activity is not evidence that the pending request was answered.
    await postAll(pane, [
      { ...firstToolDone, tool_use_id: 'toolu_other' },
      { ...secondTool, tool_use_id: 'toolu_next' }
    ])
    reconnect(pane)

    expectRefused(pane)
  })

  it('ignores settled requests on a live (non-replay) envelope', async () => {
    const pane = await waitingOnFirstRequest()
    pane.connected = false
    await pane.post(secondTool)
    const live = pane.forwarded.at(-1)
    expect(live).toMatchObject({ hookEventName: 'PreToolUse' })
    expect(live?.isReplay).toBeUndefined()
    pane.connected = true
    pane.ingested += 1
    pane.desktop.ingestRemote(
      {
        ...live,
        paneKey: PANE,
        payload: live?.payload,
        claudeSettledRequests: [{ toolUseId: String(firstTool.tool_use_id) }]
      },
      'conn-1'
    )
    expectRefused(pane)
  })
})

describe.each([
  ['lead', selfDenied.leadDenied],
  ['subagent', selfDenied.childDenied]
])('a relayed %s permission wait that Claude denies itself (captured)', (_owner, events) => {
  const permissionIndex = events.findIndex((event) => event.hook_event_name === 'PermissionRequest')
  const batchIndex = events.findIndex((event) => event.hook_event_name === 'PostToolBatch')
  const untilWait = events.slice(0, permissionIndex + 1)
  const untilBatch = events.slice(permissionIndex + 1, batchIndex + 1)

  it('clears when its batch end arrives live', async () => {
    const pane = await startSshPane()
    await postAll(pane, untilWait)
    expectRefused(pane)
    await postAll(pane, untilBatch)
    expectRefused(pane)
  })

  it('clears on reconnect when the batch ended it while the desktop was away', async () => {
    const pane = await startSshPane()
    await postAll(pane, untilWait)
    pane.connected = false
    await postAll(pane, [...untilBatch, events[batchIndex + 1]])
    reconnect(pane)
    expectRefused(pane)
  })
})
