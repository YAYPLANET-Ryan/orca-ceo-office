import { expect, it } from 'vitest'
import { RequestedProviderIntentFence } from './requested-provider-intent-fence'
import type { HookContextSnapshot } from './hook-context-snapshot'

const snapshot: HookContextSnapshot = {
  executionHostId: 'local',
  paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
  worktreeId: 'workspace-a',
  ptyId: 'pty-a',
  incarnationId: 'generation-a',
  launchTokenHash: 'a'.repeat(64),
  cwd: '/workspace-a',
  reportedCwd: '/workspace-a',
  resumeIntent: { agentType: 'claude', providerSessionId: 'original-conversation' }
}

it('refuses new match establishment at capacity without evicting an existing owner', () => {
  const fence = new RequestedProviderIntentFence()
  for (let index = 0; index < 4096; index++) {
    fence.commit(
      { ...snapshot, ptyId: `pty-${index}` },
      'claude',
      'original-conversation',
      'SessionStart',
      'resume'
    )
  }
  expect(fence.check(snapshot, 'claude', 'original-conversation', 'SessionStart', 'resume')).toBe(
    'resume_provider_verification_capacity'
  )
  expect(
    fence.check(
      { ...snapshot, ptyId: 'pty-0' },
      'claude',
      'original-conversation',
      'Stop',
      undefined
    )
  ).toBeNull()
  fence.retire('pty-0', 'wrong-generation')
  fence.retire('pty-0', undefined)
  expect(fence.check(snapshot, 'claude', 'original-conversation', 'SessionStart', 'resume')).toBe(
    'resume_provider_verification_capacity'
  )
  fence.retire('pty-0', 'generation-a')
  expect(
    fence.check(snapshot, 'claude', 'original-conversation', 'SessionStart', 'resume')
  ).toBeNull()
})

it('does not reset a verified scope when the intent object uses a different key order', () => {
  const fence = new RequestedProviderIntentFence()
  fence.commit(snapshot, 'claude', 'original-conversation', 'SessionStart', 'resume')
  const reordered = {
    ...snapshot,
    resumeIntent: { providerSessionId: 'original-conversation', agentType: 'claude' as const }
  }
  expect(
    fence.check(reordered, 'claude', 'cleared-conversation', 'SessionStart', 'clear')
  ).toBeNull()
})

it('never establishes a match from unavailable or declared-fresh metadata', () => {
  const fence = new RequestedProviderIntentFence()
  for (let index = 0; index < 4096; index++) {
    fence.commit(
      { ...snapshot, ptyId: `unknown-${index}`, resumeIntent: index % 2 === 0 ? undefined : null },
      'claude',
      'original-conversation',
      'SessionStart',
      'startup'
    )
  }
  expect(
    fence.check(snapshot, 'claude', 'original-conversation', 'SessionStart', 'resume')
  ).toBeNull()
})

function observedSnapshot(): HookContextSnapshot {
  const scope = {
    ptyId: snapshot.ptyId,
    incarnationId: snapshot.incarnationId,
    paneKey: snapshot.paneKey,
    worktreeId: snapshot.worktreeId,
    ownerClientInstanceId: 'b'.repeat(64),
    launchTokenHash: snapshot.launchTokenHash,
    launchCwd: snapshot.cwd,
    cwd: snapshot.cwd
  }
  return {
    ...snapshot,
    ...scope,
    providerObservation: {
      ...scope,
      version: 1,
      revision: 2,
      agentType: 'claude',
      providerSessionId: 'cleared-conversation',
      originalProviderSessionId: 'original-conversation',
      transition: 'clear'
    }
  }
}

it('seeds a new fence only from the same owned host generation, preserving the original intent', () => {
  const resumed = observedSnapshot()
  const fence = new RequestedProviderIntentFence()
  expect(fence.check(resumed, 'claude', 'cleared-conversation', 'Stop', undefined)).toBeNull()
  expect(fence.check(resumed, 'claude', 'original-conversation', 'Stop', undefined)).toBe(
    'resume_provider_transition_unconfirmed'
  )
  expect(resumed.resumeIntent?.providerSessionId).toBe('original-conversation')
})

it.each([
  { incarnationId: 'other-generation' },
  { paneKey: 'other-pane' },
  { worktreeId: 'other-workspace' },
  { ownerClientInstanceId: 'c'.repeat(64) },
  { launchTokenHash: 'd'.repeat(64) },
  { launchCwd: '/other-root' },
  { cwd: '/other-root' },
  { originalProviderSessionId: 'foreign-conversation' },
  { agentType: 'codex' as const }
])('refuses restoration from a mismatched host observation', (changed) => {
  const resumed = observedSnapshot()
  resumed.providerObservation = {
    ...resumed.providerObservation!,
    ...changed
  }
  expect(
    new RequestedProviderIntentFence().check(
      resumed,
      'claude',
      'cleared-conversation',
      'Stop',
      undefined
    )
  ).toBe('resume_provider_id_mismatch')
})

it('does not seed host observations from replay or roll back a locally committed clear', () => {
  const resumed = observedSnapshot()
  expect(
    new RequestedProviderIntentFence().check(
      resumed,
      'claude',
      'cleared-conversation',
      'Stop',
      undefined,
      true
    )
  ).toBe('resume_provider_replay_unverified')
  const fence = new RequestedProviderIntentFence()
  fence.commit(resumed, 'claude', 'next-clear', 'SessionStart', 'clear')
  expect(fence.check(resumed, 'claude', 'next-clear', 'Stop', undefined)).toBeNull()
  expect(fence.check(resumed, 'claude', 'cleared-conversation', 'Stop', undefined)).toBe(
    'resume_provider_transition_unconfirmed'
  )
})
