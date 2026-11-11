import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { createHookListenerState } from '../../../../../shared/agent-hook-listener/listener-state'
import { normalizeHookPayload } from '../../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import type { EnrichedAgentHookEventPayload } from '../../server-types'
import { buildBody, PANE } from '../server.test-fixtures'

import { attestFixtureHookContext } from '../attested-hook-context.test-fixtures'
vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const CONNECTION = 'conn-1'
const T0 = 1_800_000_000_000

function ingest(
  server: AgentHookServer,
  payload: Record<string, unknown>,
  options: { isReplay?: boolean } = {}
): void {
  const event = normalizeHookPayload(
    createHookListenerState(),
    'claude',
    buildBody(payload),
    'production'
  )
  if (!event) {
    throw new Error('normalizeHookPayload rejected a known-good Claude fixture')
  }
  server.ingestRemote({ ...event, ...(options.isReplay ? { isReplay: true } : {}) }, CONNECTION)
}

describe('the observation clock a relay replay must not restamp', () => {
  let server: AgentHookServer
  let emitted: EnrichedAgentHookEventPayload[]

  beforeEach(() => {
    _internals.resetCachesForTests()
    vi.useFakeTimers()
    vi.setSystemTime(T0)
    server = attestFixtureHookContext(new AgentHookServer())
    emitted = []
    server.setListener((payload) => {
      emitted.push(payload)
    })
  })

  afterEach(() => {
    server.setListener(null)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // Fork 6d65165647: relayed Claude/Codex status is refused without attestation, so neither a
  // live nor a replayed relay event publishes a row or an observation time to restamp.
  const expectRefused = (count: number): void => {
    expect(emitted.filter((event) => event.paneKey === PANE)).toEqual([])
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getContextIntegrityRejections()).toEqual({
      remote_context_attestation_unavailable: count
    })
  }

  it('holds the observation time across a reconnect replay while delivery order advances', () => {
    ingest(server, { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' })
    expectRefused(1)

    vi.setSystemTime(T0 + 25 * 60 * 1000)
    server.clearStatusEntriesForConnection(CONNECTION)
    ingest(
      server,
      { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' },
      { isReplay: true }
    )

    expectRefused(2)
  })

  it('carries the observation time out of getStatusSnapshot, not just the listener', () => {
    ingest(server, { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' })
    vi.setSystemTime(T0 + 25 * 60 * 1000)
    server.clearStatusEntriesForConnection(CONNECTION)
    ingest(
      server,
      { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' },
      { isReplay: true }
    )

    expect(server.getStatusSnapshot().find((entry) => entry.paneKey === PANE)).toBeUndefined()
    expectRefused(2)
  })

  it('lets a live event restamp the observation time after a replay', () => {
    ingest(server, { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' })
    vi.setSystemTime(T0 + 25 * 60 * 1000)
    server.clearStatusEntriesForConnection(CONNECTION)
    ingest(
      server,
      { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' },
      { isReplay: true }
    )

    vi.setSystemTime(T0 + 26 * 60 * 1000)
    ingest(server, { hook_event_name: 'PreToolUse', tool_name: 'Edit' })
    expectRefused(3)
  })

  it('gives a torn-down pane no inherited observation time', () => {
    ingest(server, { hook_event_name: 'UserPromptSubmit', prompt: 'do the thing' })
    server.clearPaneState(PANE)

    vi.setSystemTime(T0 + 25 * 60 * 1000)
    ingest(
      server,
      { hook_event_name: 'UserPromptSubmit', prompt: 'a new session' },
      { isReplay: true }
    )
    expectRefused(2)
  })
})
