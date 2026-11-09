import { describe, expect, it } from 'vitest'
import { retainResumeCheckpoint, retainedResumeIdentity } from './runtime-resume-checkpoint'
import { sanitizeHydratedEntry } from './server-persistence-validation'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { admittedResumeCheckpoint } from './admitted-resume-checkpoint'
import { parseHookEnvelope } from '../../../shared/agent-hook-listener/hook-envelope'
import { createHookListenerState } from '../../../shared/agent-hook-listener/listener-state'
import type { AdmittedHookContext } from './hook-context-snapshot'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'
const checkpoint: EnrichedAgentHookEventPayload = {
  paneKey: PANE,
  tabId: 'tab-1',
  worktreeId: 'workspace-a',
  connectionId: null,
  providerSession: { key: 'session_id', id: 'original-conversation' },
  runtimeResumeCheckpoint: true,
  payload: { agentType: 'claude', state: 'done', prompt: '' },
  receivedAt: 100,
  stateStartedAt: 100
}

describe('resume checkpoint ownership', () => {
  it('retains the original conversation checkpoint for its exact pane and workspace', () => {
    expect(retainResumeCheckpoint(checkpoint, { ...checkpoint }, 'hook')).toEqual({
      runtimeResumeCheckpoint: true
    })
  })

  it('does not lend a checkpoint to another conversation in the same terminal', () => {
    expect(
      retainResumeCheckpoint(
        checkpoint,
        { ...checkpoint, providerSession: { key: 'session_id', id: 'other-conversation' } },
        'hook'
      )
    ).toEqual({})
  })

  it.each([
    { worktreeId: 'workspace-b' },
    { connectionId: 'other-host' },
    { paneKey: 'tab-other:22222222-2222-4222-8222-222222222222' }
  ])('does not transfer a matching provider ID across owner boundaries: %j', (owner) => {
    expect(retainResumeCheckpoint(checkpoint, { ...checkpoint, ...owner }, 'hook')).toEqual({})
  })

  it('keeps an unobserved recipe unverified through retention and hydration', () => {
    const unobserved: EnrichedAgentHookEventPayload = {
      ...checkpoint,
      launchToken: 'synthetic-fixture-capability',
      runtimeResumePendingObservation: true
    }
    const retained = retainedResumeIdentity(unobserved)
    expect(retained?.providerSession?.id).toBe('original-conversation')
    expect(retained?.launchToken).toBeUndefined()
    expect(retained?.runtimeResumePendingObservation).toBe(true)
    const hydrated = sanitizeHydratedEntry(PANE, JSON.parse(JSON.stringify(retained)))
    expect(hydrated?.runtimeResumePendingObservation).toBe(true)
    expect(retainResumeCheckpoint(hydrated ?? undefined, checkpoint, 'hook')).toEqual({})
  })
})

function admittedContext(sessionId: string | undefined): AdmittedHookContext {
  const envelope = parseHookEnvelope(
    createHookListenerState(),
    'claude',
    {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'workspace-a',
      env: 'production',
      payload: { hook_event_name: 'SessionStart', session_id: sessionId }
    },
    'production'
  )
  if (!envelope) {
    throw new Error('Invalid isolated admission fixture')
  }
  return {
    envelope,
    snapshot: {
      executionHostId: 'local',
      paneKey: PANE,
      worktreeId: 'workspace-a',
      ptyId: 'fixture-pty',
      incarnationId: 'fixture-generation',
      launchTokenHash: 'fixture-hash',
      cwd: '/workspace-a',
      reportedCwd: '/workspace-a'
    },
    processRootVerified: true,
    ownerExit: undefined,
    release() {}
  }
}

it('lets the current admitted provider earn its own checkpoint without lending from a prior ID', () => {
  const observed = { ...checkpoint, runtimeResumeCheckpoint: undefined }
  const next = admittedResumeCheckpoint(
    'claude',
    admittedContext('original-conversation'),
    observed,
    new Map([[PANE, observed]])
  )
  expect(next?.runtimeResumeCheckpoint).toBe(true)
  expect(next?.providerSession?.id).toBe('original-conversation')
})

it.each([undefined, 'different-conversation'])(
  'does not checkpoint inherited row identity when the hook asserted %s',
  (sessionId) => {
    expect(
      admittedResumeCheckpoint(
        'claude',
        admittedContext(sessionId),
        checkpoint,
        new Map([[PANE, checkpoint]])
      )
    ).toBeNull()
  }
)

it('does not checkpoint a row superseded during synchronous observation callbacks', () => {
  expect(
    admittedResumeCheckpoint(
      'claude',
      admittedContext('original-conversation'),
      checkpoint,
      new Map([[PANE, { ...checkpoint }]])
    )
  ).toBeNull()
})

it('does not treat the legacy unguarded admission result as provider proof', () => {
  expect(
    admittedResumeCheckpoint('claude', true, checkpoint, new Map([[PANE, checkpoint]]))
  ).toBeNull()
})

it('does not clear an unobserved launch restriction without a matching capability', () => {
  const pending: EnrichedAgentHookEventPayload = {
    ...checkpoint,
    runtimeResumePendingObservation: true
  }
  const next = admittedResumeCheckpoint(
    'claude',
    admittedContext('original-conversation'),
    pending,
    new Map([[PANE, pending]])
  )
  expect(next?.runtimeResumePendingObservation).toBe(true)
})
