import { describe, expect, it } from 'vitest'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import { providerSessionStatusUpdate } from './agent-provider-session-update'

describe('runtime checkpoint versus hidden liveness identity', () => {
  const event = {
    paneKey: 'tab:leaf',
    agentType: 'codex',
    providerSessionOnly: true,
    providerSession: { key: 'session_id', id: 'original' },
    receivedAt: 10,
    connectionId: null,
    state: 'working',
    prompt: ''
  } as AgentStatusIpcPayload
  it('does not project an explicitly hidden liveness remnant into recovery', () => {
    expect(
      providerSessionStatusUpdate(
        { ...event, retainedForLiveness: true },
        event.paneKey,
        'tab',
        'wt',
        null
      )
    ).toBeNull()
  })
  it('keeps a durable checkpoint behind a pending confirmation fence', () => {
    expect(
      providerSessionStatusUpdate(
        { ...event, runtimeResumeCheckpoint: true },
        event.paneKey,
        'tab',
        'wt',
        null
      )?.metadata?.preserveResumeCheckpoint
    ).toBe(true)
  })
  it('keeps the legacy wire fallback when optional markers are absent', () => {
    expect(
      providerSessionStatusUpdate(event, event.paneKey, 'tab', 'wt', null)?.providerSession
    ).toEqual(event.providerSession)
  })
})
