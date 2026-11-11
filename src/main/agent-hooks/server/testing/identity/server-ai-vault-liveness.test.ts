import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, postHookEvent } from '../server.test-fixtures'

import { attestFixtureHookContext } from '../attested-hook-context.test-fixtures'
const PANE = makePaneKey('external-live', '11111111-1111-4111-8111-111111111111')
const PROVIDER_SESSION = { key: 'session_id' as const, id: 'session-live' }

// Fork 6d65165647: a relayed provider session is refused without attestation for any agent, so
// this liveness test seeds the gemini identity through a local hook instead of a relay.
async function seedLocalIdentity(server: AgentHookServer): Promise<void> {
  const response = await postHookEvent(
    server,
    buildBody(
      { hook_event_name: 'BeforeAgent', session_id: PROVIDER_SESSION.id, prompt: 'test' },
      { paneKey: PANE, tabId: 'external-live' }
    ),
    '/hook/gemini'
  )
  expect(response.status).toBe(204)
  expect(server.getStatusSnapshot()[0]?.providerSession).toEqual(PROVIDER_SESSION)
  server.ingestTerminalStatus({
    paneKey: PANE,
    connectionId: null,
    payload: { state: 'working', prompt: 'test', agentType: 'gemini' }
  })
}

describe('AgentHookServer AI Vault liveness identity', () => {
  it('hydrates dismissed provider identity without reviving visible status', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'orca-ai-vault-liveness-'))
    const first = attestFixtureHookContext(new AgentHookServer())
    try {
      await first.start({ env: 'production', userDataPath })
      await seedLocalIdentity(first)
      first.dropStatusEntry(PANE)
      first.flushStatusPersistSync()
      first.stop()

      const second = attestFixtureHookContext(new AgentHookServer())
      await second.start({ env: 'production', userDataPath })
      try {
        expect(second.getStatusSnapshot()).toEqual([
          expect.objectContaining({
            providerSession: PROVIDER_SESSION,
            providerSessionOnly: true,
            restoredUnconfirmed: true
          })
        ])
        expect(second.getStatusChangeSnapshot()).toEqual([])
      } finally {
        second.stop()
      }
    } finally {
      first.stop()
      await rm(userDataPath, { recursive: true, force: true })
    }
  })
})
