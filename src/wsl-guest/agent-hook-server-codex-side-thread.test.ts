import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentHookRelayEnvelope } from '../shared/agent-hook-listener/transport/agent-hook-relay'
import { RelayAgentHookServer } from './agent-hook-server'
import { AgentHookServer } from '../main/agent-hooks/server/agent-hook-server'

import { attestFixtureHookContext } from '../main/agent-hooks/server/testing/attested-hook-context.test-fixtures'
const PANE_KEY = 'tab-1:11111111-1111-4111-8111-111111111111'
// Fork 6d65165647: relay Claude/Codex status is refused without attestation.
const REMOTE_REFUSAL = 'remote_context_attestation_unavailable'
const refusals = (server: AgentHookServer): number =>
  server.getContextIntegrityRejections()[REMOTE_REFUSAL] ?? 0

it('keeps a remote main Codex turn working through /side chats across relay restarts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-codex-side-'))
  const desktop = attestFixtureHookContext(new AgentHookServer())
  const forward = (envelope: AgentHookRelayEnvelope): void =>
    void desktop.ingestRemote(envelope, 'ssh-connection')
  let relay = new RelayAgentHookServer({ endpointDir: dir, forward })
  const restartRelay = async (): Promise<void> => {
    relay.stop()
    relay = new RelayAgentHookServer({ endpointDir: dir, forward })
    await relay.start()
  }
  const post = async (payload: Record<string, unknown>): Promise<void> => {
    const { port, token } = relay.getCoordinates()
    const response = await fetch(`http://127.0.0.1:${port}/hook/codex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({ paneKey: PANE_KEY, tabId: 'tab-1', worktreeId: 'folder-1', payload })
    })
    expect(response.status).toBe(204)
    expect(desktop.getStatusSnapshot()).toEqual([])
  }
  await relay.start()
  try {
    const main = { session_id: 'main-session', transcript_path: join(dir, 'rollout-main.jsonl') }
    await post({ ...main, hook_event_name: 'UserPromptSubmit', prompt: 'remote main' })
    // A relay restarted before the chat opens sees the fork's own SessionStart.
    await restartRelay()
    const first = { session_id: 'side-1', transcript_path: null }
    await post({ ...first, hook_event_name: 'SessionStart', source: 'fork' })
    await post({ ...first, hook_event_name: 'UserPromptSubmit', prompt: 'side chat' })
    await post({ ...first, hook_event_name: 'Stop' })
    // One restarted mid-chat forwards the rest; the desktop keeps the running main turn.
    const second = { session_id: 'side-2', transcript_path: null }
    await post({ ...second, hook_event_name: 'SessionStart', source: 'fork' })
    await restartRelay()
    await post({ ...second, hook_event_name: 'UserPromptSubmit', prompt: 'side chat' })
    await post({ ...second, hook_event_name: 'Stop' })
    const { port, token } = relay.getCoordinates()
    await fetch(`http://127.0.0.1:${port}/hook/codex`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
      body: JSON.stringify({
        paneKey: PANE_KEY,
        tabId: 'tab-1',
        worktreeId: 'folder-1',
        payload: { ...main, hook_event_name: 'Stop' }
      })
    })
    expect(desktop.getStatusSnapshot()).toEqual([])
    expect(refusals(desktop)).toBe(4)
  } finally {
    relay.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('lets a new remote ephemeral Codex conversation replace a row left working', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-codex-new-'))
  const desktop = attestFixtureHookContext(new AgentHookServer())
  const relay = new RelayAgentHookServer({
    endpointDir: dir,
    forward: (envelope) => void desktop.ingestRemote(envelope, 'ssh-connection')
  })
  await relay.start()
  try {
    const { port, token } = relay.getCoordinates()
    const post = (payload: Record<string, unknown>): Promise<Response> =>
      fetch(`http://127.0.0.1:${port}/hook/codex`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Orca-Agent-Hook-Token': token },
        body: JSON.stringify({ paneKey: PANE_KEY, tabId: 'tab-1', worktreeId: 'folder-1', payload })
      })
    // The old Codex died mid-turn without a Stop, so its row still says working.
    await post({
      session_id: 'old-session',
      transcript_path: join(dir, 'rollout-old.jsonl'),
      hook_event_name: 'UserPromptSubmit',
      prompt: 'old task'
    })
    const next = { session_id: 'new-session', transcript_path: null }
    await post({ ...next, hook_event_name: 'SessionStart', source: 'startup' })
    await post({ ...next, hook_event_name: 'UserPromptSubmit', prompt: 'new task' })
    expect(desktop.getStatusSnapshot()).toEqual([])
    expect(refusals(desktop)).toBe(2)
  } finally {
    relay.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
