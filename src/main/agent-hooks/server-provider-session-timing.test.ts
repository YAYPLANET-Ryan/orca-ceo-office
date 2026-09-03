import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer, _internals } from './server'
import { PANE } from './server.test-fixtures'

const { getCohortAtEmitMock, trackMock } = vi.hoisted(() => ({
  getCohortAtEmitMock: vi.fn(() => ({})),
  trackMock: vi.fn()
}))

vi.mock('../telemetry/client', () => ({ track: trackMock }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: getCohortAtEmitMock }))

describe('provider session status timing', () => {
  let server: AgentHookServer

  beforeEach(() => {
    vi.useFakeTimers()
    _internals.resetCachesForTests()
    server = new AgentHookServer()
  })

  afterEach(() => {
    server.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function ingest(
    now: number,
    hookEventName: string,
    sessionId: string,
    prompt = 'turn'
  ): number | undefined {
    vi.setSystemTime(now)
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        source: 'codex',
        hookEventName,
        providerSession: { key: 'session_id', id: sessionId },
        payload: { state: 'working', prompt, agentType: 'codex' }
      },
      'conn-a'
    )
    return server.getStatusSnapshot()[0]?.stateStartedAt
  }

  it('preserves mid-turn timing but resets it at provider turn and session boundaries', () => {
    expect(ingest(1_000, 'PostToolUse', 'session-a')).toBe(1_000)
    expect(ingest(2_000, 'PostToolUse', 'session-a')).toBe(1_000)
    expect(ingest(3_000, 'UserPromptSubmit', 'session-a', 'next turn')).toBe(3_000)
    expect(ingest(4_000, 'PostToolUse', 'session-b', 'replacement')).toBe(4_000)
  })
})
