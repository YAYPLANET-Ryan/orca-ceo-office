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
