import { expect, it, vi } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-listener/transport/agent-hook-relay'
import { RelayAgentHookServer } from './agent-hook-server'
import { AgentHookServer } from '../main/agent-hooks/server/agent-hook-server'

import { attestFixtureHookContext } from '../main/agent-hooks/server/testing/attested-hook-context.test-fixtures'
const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
// Fork 6d65165647: relay Claude/Codex status is refused without attestation.
const REMOTE_REFUSAL = 'remote_context_attestation_unavailable'
const line = (payload: unknown): string => `${JSON.stringify({ type: 'event_msg', payload })}\n`

it('forwards host-confirmed Codex interruption without requiring a local rollout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-codex-interruption-'))
  const transcriptPath = join(dir, 'rollout-root.jsonl')
  writeFileSync(transcriptPath, line({ type: 'task_started', turn_id: 'turn-1' }))
  const desktop = attestFixtureHookContext(new AgentHookServer())
  const forward = vi.fn((envelope: AgentHookRelayEnvelope) =>
    desktop.ingestRemote(envelope, 'ssh-connection')
  )
  const server = new RelayAgentHookServer({ endpointDir: dir, forward })
  await server.start()
  try {
    const { port, token } = server.getCoordinates()
    const response = await fetch(`http://127.0.0.1:${port}/hook/codex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'folder-1',
        payload: {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'main-session',
          prompt: 'remote main task',
          transcript_path: transcriptPath
        }
      })
    })
    expect(response.status).toBe(204)
    expect(desktop.getStatusSnapshot()).toEqual([])
    expect(desktop.getContextIntegrityRejections()[REMOTE_REFUSAL]).toBe(1)
    const sideResponse = await fetch(`http://127.0.0.1:${port}/hook/codex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'folder-1',
        payload: {
          hook_event_name: 'UserPromptSubmit',
          session_id: 'side-session',
          transcript_path: null,
          prompt: 'side chat'
        }
      })
    })
    expect(sideResponse.status).toBe(204)
    expect(forward).toHaveBeenCalledTimes(1)

    appendFileSync(
      transcriptPath,
      line({ type: 'turn_aborted', turn_id: 'turn-1', reason: 'interrupted' })
    )
    // The execution host still forwards its confirmed interruption; the desktop refuses it too.
    await vi.waitFor(() => expect(forward).toHaveBeenCalledTimes(2), { timeout: 2_000 })
    expect(forward.mock.calls.at(-1)?.[0].hookEventName).toBeUndefined()
    expect(forward.mock.calls.at(-1)?.[0].payload).toMatchObject({
      state: 'done',
      interrupted: true,
      mainAgent: { state: 'done', outcome: 'cancellation' }
    })
    expect(desktop.getContextIntegrityRejections()[REMOTE_REFUSAL]).toBe(2)
    expect(desktop.getStatusSnapshot()).toEqual([])
  } finally {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
