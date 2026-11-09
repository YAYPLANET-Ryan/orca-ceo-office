import { expect, it } from 'vitest'
import {
  readHookProviderObservation,
  readHookProviderObservationUpdate
} from './hook-provider-observation'

const observation = {
  version: 1,
  revision: 1,
  ptyId: 'pty',
  incarnationId: 'generation',
  paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
  worktreeId: 'workspace',
  ownerClientInstanceId: 'a'.repeat(64),
  launchTokenHash: 'b'.repeat(64),
  cwd: '/workspace',
  launchCwd: '/workspace',
  agentType: 'claude',
  providerSessionId: 'original',
  originalProviderSessionId: 'original',
  transition: 'requested-id-matched'
}

it('copies and freezes only the selected observation fields without accepting raw capabilities', () => {
  const mutable = { ...observation }
  const read = readHookProviderObservation(mutable)
  mutable.providerSessionId = 'changed'
  expect(read?.providerSessionId).toBe('original')
  expect(Object.isFrozen(read)).toBe(true)
  expect(
    readHookProviderObservation({ ...observation, launchToken: 'synthetic-capability' })
  ).toBeUndefined()
})

it.each([
  { version: 2 },
  { revision: 0 },
  { revision: Number.MAX_SAFE_INTEGER + 1 },
  { providerSessionId: ' different' },
  { providerSessionId: 'bad\0id' },
  { originalProviderSessionId: 'different' },
  { transition: 'observed' }
])('rejects contradictory or malformed receipts', (changed) => {
  expect(readHookProviderObservation({ ...observation, ...changed })).toBeUndefined()
})

it('enforces a UTF-8 byte bound in both directions, beyond individual character limits', () => {
  const large = {
    ...observation,
    ptyId: '가'.repeat(16000),
    worktreeId: '나'.repeat(8000),
    cwd: `/${'다'.repeat(8000)}`,
    launchCwd: `/${'라'.repeat(8000)}`
  }
  expect(readHookProviderObservation(large)).toBeUndefined()
  const {
    version: _version,
    revision: _revision,
    originalProviderSessionId: _original,
    ...scope
  } = large
  expect(
    readHookProviderObservationUpdate({
      ...scope,
      expectedRevision: 0,
      transition: 'observed',
      launchToken: 'synthetic-capability'
    })
  ).toBeUndefined()
})
