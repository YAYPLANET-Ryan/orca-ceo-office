import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { normalizeHookPayload } from '../../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { createHookListenerState } from '../../../../../shared/agent-hook-listener/listener-state'
import { resumeRecordFromStatus } from '../../../../../shared/agent-session/lifecycle/agent-resume-record-from-status'
import { getAgentResumeArgv } from '../../../../../shared/agent-launch/startup/agent-resume-argv'
import type { AgentHookRelayEnvelope } from '../../../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { RelayAgentHookServer } from '../../../../../wsl-guest/agent-hook-server'
import { AgentHookServer } from '../../agent-hook-server'
import { buildBody, postHookEvent } from '../server.test-fixtures'

import { attestFixtureHookContext } from '../attested-hook-context.test-fixtures'
const ROOT = 'local-parent'
const CHILD = '20261024_child'
// Order captured from a real Hermes delegate_task run; tools/end omit platform.
const HOOKS = [
  { hook_event_name: 'on_session_start', session_id: CHILD, platform: 'subagent' },
  { hook_event_name: 'pre_llm_call', session_id: CHILD, platform: 'subagent' },
  { hook_event_name: 'pre_tool_call', session_id: CHILD, tool_name: 'read_file' },
  { hook_event_name: 'post_llm_call', session_id: CHILD, platform: 'subagent' },
  { hook_event_name: 'on_session_end', session_id: CHILD }
]

function normalize(payload: Record<string, unknown>) {
  const event = normalizeHookPayload(
    createHookListenerState(),
    'hermes',
    buildBody(payload),
    'production'
  )
  if (!event) {
    throw new Error('Hermes hook was rejected')
  }
  return event
}

function root(id = ROOT, platform = 'cli', hook_event_name = 'pre_llm_call') {
  return normalize({ hook_event_name, session_id: id, platform, user_message: 'delegate it' })
}

// Fork 6d65165647: a relayed provider session is refused without attestation for any agent, and
// an unattested (non-Claude/Codex) hook aimed at a pane Claude/Codex holds is refused too.
const REMOTE_REFUSAL = 'remote_context_attestation_unavailable'
const PROTECTED_PANE_REFUSAL = 'unattested_source_targets_protected_pane'

function expectNoResumeIdentity(server: AgentHookServer) {
  expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
  expect(server.getProviderSessionIdentities()).toEqual([])
}

function expectResume(server: AgentHookServer, id = ROOT) {
  const status = server.getStatusSnapshot()[0]
  if (!status) {
    throw new Error('Missing Hermes status')
  }
  expect(status).not.toHaveProperty('statusAdmissionSession')
  const record = resumeRecordFromStatus({
    entry: { ...status, updatedAt: status.receivedAt },
    worktreeId: 'wt-1',
    capturedAt: status.receivedAt
  })
  expect(record?.providerSession.id).toBe(id)
  if (!record) {
    throw new Error('Missing Hermes resume record')
  }
  expect(getAgentResumeArgv('hermes', record.providerSession)).toEqual(['hermes', '--resume', id])
}

it.each(HOOKS.map((_, index) => index))(
  'keeps the persisted root after restart before child hook %s',
  async (start) => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-resume-identity-'))
    let server = attestFixtureHookContext(new AgentHookServer())
    try {
      await server.start({ env: 'production', userDataPath: dir })
      // The relayed root carries its provider session, so it is refused and nothing persists.
      server.ingestRemote(root(), 'host-1')
      expect(server.getStatusSnapshot()).toEqual([])
      expect(server.getContextIntegrityRejections()).toEqual({ [REMOTE_REFUSAL]: 1 })
      server.stop()
      server = attestFixtureHookContext(new AgentHookServer())
      await server.start({ env: 'production', userDataPath: dir })
      for (const hook of HOOKS.slice(start)) {
        const event = normalize(hook)
        expect(event.providerSession).toBeUndefined()
        // Sessionless child hooks still flow, but there is no root identity for them to keep.
        server.ingestRemote(event, 'host-1')
        expectNoResumeIdentity(server)
      }
      expect(server.getContextIntegrityRejections()).toEqual({})
      server.stop()
      server = attestFixtureHookContext(new AgentHookServer())
      await server.start({ env: 'production', userDataPath: dir })
      expectNoResumeIdentity(server)
      server.ingestRemote(root('selected-root', 'tui', 'on_session_reset'), 'host-1')
      expectNoResumeIdentity(server)
      expect(server.getContextIntegrityRejections()).toEqual({ [REMOTE_REFUSAL]: 1 })
      server.ingestRemote(normalize(HOOKS[2]), 'host-2')
      expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
    } finally {
      server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

it.each(['local', 'relay'] as const)(
  'preserves root status re-entry without tool-derived restore identity over %s',
  async (transport) => {
    const dir = mkdtempSync(join(tmpdir(), 'hermes-status-admission-'))
    const server = attestFixtureHookContext(new AgentHookServer())
    const forwarded: AgentHookRelayEnvelope[] = []
    const relay = new RelayAgentHookServer({
      endpointDir: dir,
      forward: (event) => {
        forwarded.push(event)
        server.ingestRemote(event, 'host-1')
      }
    })
    try {
      await server.start({ env: 'production' })
      if (transport === 'relay') {
        await relay.start()
      }
      const post = async (source: 'hermes' | 'codex', payload: Record<string, unknown>) => {
        const body = buildBody(payload)
        const response =
          transport === 'local'
            ? await postHookEvent(server, body, `/hook/${source}`)
            : await fetch(`http://127.0.0.1:${relay.getCoordinates().port}/hook/${source}`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Orca-Agent-Hook-Token': relay.getCoordinates().token
                },
                body: JSON.stringify(body)
              })
        expect(response.status).toBe(204)
      }
      const local = transport === 'local'
      const rejections = () => server.getContextIntegrityRejections()
      // Locally the root hook binds the Hermes identity; over the relay its provider session is
      // refused, so later relayed Hermes rows carry no resume identity at all.
      await post('hermes', { hook_event_name: 'pre_llm_call', session_id: ROOT, platform: 'cli' })
      if (local) {
        expectResume(server)
      } else {
        expect(server.getStatusSnapshot()).toEqual([])
        expect(rejections()).toEqual({ [REMOTE_REFUSAL]: 1 })
      }
      await post('hermes', {
        hook_event_name: 'pre_llm_call',
        session_id: CHILD,
        platform: 'subagent'
      })
      await post('hermes', { hook_event_name: 'on_session_end', session_id: CHILD })
      await post('hermes', {
        hook_event_name: 'post_tool_call',
        session_id: 'unknown-child',
        tool_name: 'read_file'
      })
      const delayedUnknown = forwarded.at(-1)
      await post('hermes', { hook_event_name: 'on_session_end', session_id: CHILD })
      expect(server.getStatusSnapshot()[0]).toMatchObject({ agentType: 'hermes', state: 'done' })
      await post('codex', {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'nested',
        prompt: 'review'
      })
      if (local) {
        // The attested local Codex hook takes the pane; Hermes hooks aimed at it are now refused.
        expect(server.getStatusSnapshot()[0]).toMatchObject({
          agentType: 'codex',
          providerSession: { id: 'nested' }
        })
        expect(rejections()).toEqual({})
      } else {
        expect(server.getStatusSnapshot()[0]?.agentType).toBe('hermes')
        expect(rejections()).toEqual({ [REMOTE_REFUSAL]: 2 })
      }
      if (transport === 'relay') {
        if (!delayedUnknown) {
          throw new Error('Missing relay child event')
        }
        expect(delayedUnknown.agentPresence).toEqual({ agent: 'hermes', session: 'unknown-child' })
        server.ingestRemote(delayedUnknown, 'host-1')
        expect(server.getStatusSnapshot()[0]?.agentType).toBe('hermes')
        expect(rejections()).toEqual({ [REMOTE_REFUSAL]: 2 })
      }
      // Locally every Hermes hook below targets the Codex-held pane and is refused, leaving the
      // Codex row untouched; over the relay the sessionless ones still apply without an identity.
      const expectNested = (refused: number) => {
        expect(server.getStatusSnapshot()[0]).toMatchObject({
          agentType: 'codex',
          state: 'working',
          providerSession: { id: 'nested' }
        })
        expect(rejections()).toEqual({ [PROTECTED_PANE_REFUSAL]: refused })
      }
      await post('hermes', {
        hook_event_name: 'post_tool_call',
        session_id: 'unknown-child',
        tool_name: 'read_file'
      })
      if (local) {
        expectNested(1)
      } else {
        expect(server.getStatusSnapshot()[0]?.agentType).toBe('hermes')
      }
      await post('hermes', {
        hook_event_name: 'post_tool_call',
        session_id: ROOT,
        tool_name: 'delegate_task'
      })
      if (local) {
        expectNested(2)
      } else {
        expect(server.getStatusSnapshot()[0]).toMatchObject({
          agentType: 'hermes',
          state: 'working'
        })
        expectNoResumeIdentity(server)
      }
      await post('hermes', { hook_event_name: 'on_session_end', session_id: CHILD })
      if (local) {
        expectNested(3)
      } else {
        expect(server.getStatusSnapshot()[0]?.state).toBe('done')
      }
      await post('hermes', { hook_event_name: 'pre_llm_call', session_id: ROOT, platform: 'cli' })
      if (local) {
        expectNested(4)
      } else {
        expectNoResumeIdentity(server)
        expect(rejections()).toEqual({ [REMOTE_REFUSAL]: 3 })
      }
      await post('hermes', { hook_event_name: 'on_session_end', session_id: CHILD })
      await post('codex', {
        hook_event_name: 'UserPromptSubmit',
        session_id: 'nested',
        prompt: 'review'
      })
      await post('hermes', { hook_event_name: 'pre_llm_call', session_id: CHILD, platform: 'cli' })
      if (local) {
        expectNested(6)
      } else {
        expectNoResumeIdentity(server)
        expect(rejections()).toEqual({ [REMOTE_REFUSAL]: 5 })
      }
      expect(JSON.stringify(forwarded)).not.toContain('statusAdmissionSession')
    } finally {
      server.stop()
      relay.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
