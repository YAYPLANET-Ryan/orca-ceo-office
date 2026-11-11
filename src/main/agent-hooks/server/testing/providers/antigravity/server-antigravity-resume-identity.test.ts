import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { normalizeHookPayload } from '../../../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { createHookListenerState } from '../../../../../../shared/agent-hook-listener/listener-state'
import { TRANSCRIPT_MAX_SCAN_BYTES } from '../../../../../../shared/agent-hook-listener/transcript-reader'
import { AgentHookServer } from '../../../agent-hook-server'
import { buildBody, PANE } from '../../server.test-fixtures'

import { attestFixtureHookContext } from '../../attested-hook-context.test-fixtures'
// Exact origin metadata and hook shape captured from agy 1.4.11; paths/IDs are test-local.
const ROOT = '6bba92d4-47e1-440a-9571-b12bb2d474bc'
const CHILD = '2e290489-f9b1-432b-807d-f5f2acdf9421'
const ROOT_ORIGIN = {
  step_index: 0,
  source: 'USER_EXPLICIT',
  type: 'USER_INPUT',
  content: 'Reply with OK.'
}
const CHILD_ORIGIN = {
  step_index: 0,
  source: 'SYSTEM',
  type: 'SYSTEM_MESSAGE',
  content: 'sender=0ec29085-37fc-4105-b0a9-9afb536af06c'
}
const CHILD_HOOKS = [
  { hook_event_name: 'PreInvocation', initialNumSteps: 0, invocationNum: 0 },
  { hook_event_name: 'PreToolUse', toolCall: { name: 'read_file', args: {} } },
  { hook_event_name: 'PostInvocation', invocationNum: 0 },
  { hook_event_name: 'Stop', fullyIdle: true, terminationReason: 'NO_TOOL_CALL', error: '' }
]

function jsonl(...records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

function normalized(payload: Record<string, unknown>, state = createHookListenerState()) {
  const event = normalizeHookPayload(state, 'antigravity', buildBody(payload), 'production')
  if (!event) {
    throw new Error('Missing Antigravity event')
  }
  return event
}

function hook(transcriptPath: string, conversationId = ROOT, extra: Record<string, unknown> = {}) {
  return {
    hook_event_name: 'PreInvocation',
    conversationId,
    transcriptPath,
    lastUserInput: 'Reply with OK.',
    modelName: 'gemini-3.8-flash-high',
    ...extra
  }
}

// Fork 6d65165647: a relayed envelope that claims a provider session is refused without
// attestation, whatever its agent, so no relayed root binds a resume identity; relayed hooks
// without a provider claim still apply and must not mint one.
function remoteRefusals(server: AgentHookServer): number {
  return server.getContextIntegrityRejections().remote_context_attestation_unavailable ?? 0
}

function expectNoResume(server: AgentHookServer) {
  expect(server.getStatusSnapshot().every((row) => row.providerSession === undefined)).toBe(true)
}

it.each(CHILD_HOOKS.map((_, index) => index))(
  'keeps persisted root across cold child suffix %s',
  async (start) => {
    const dir = mkdtempSync(join(tmpdir(), 'agy-resume-'))
    const rootPath = join(dir, 'root.jsonl')
    const childPath = join(dir, 'child.jsonl')
    writeFileSync(rootPath, jsonl(ROOT_ORIGIN))
    writeFileSync(childPath, jsonl(CHILD_ORIGIN, ROOT_ORIGIN))
    let server = attestFixtureHookContext(new AgentHookServer())
    try {
      await server.start({ env: 'production', userDataPath: dir })
      const root = normalized(hook(rootPath))
      expect(root.providerSession?.id).toBe(ROOT)
      server.ingestRemote(root, 'host-1')
      expect(remoteRefusals(server)).toBe(1)
      expect(server.getStatusSnapshot()).toEqual([])
      server.stop()
      server = attestFixtureHookContext(new AgentHookServer())
      await server.start({ env: 'production', userDataPath: dir })
      for (const suffix of CHILD_HOOKS.slice(start)) {
        const event = normalized(hook(childPath, CHILD, { lastUserInput: '', ...suffix }))
        expect(event.providerSession).toBeUndefined()
        server.ingestRemote(event, 'host-1')
        expectNoResume(server)
      }
      server.stop()
      server = attestFixtureHookContext(new AgentHookServer())
      await server.start({ env: 'production', userDataPath: dir })
      expectNoResume(server)
      server.ingestRemote(normalized(hook(rootPath, 'later-root')), 'host-1')
      expect(remoteRefusals(server)).toBe(1)
      expectNoResume(server)
      server.ingestRemote(
        { ...normalized(hook(childPath, CHILD)), worktreeId: 'other-worktree' },
        'host-1'
      )
      expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
      server.ingestRemote(normalized(hook(childPath, CHILD)), 'host-2')
      expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
      server.ingestRemote(normalized(hook(childPath, CHILD)), 'host-1')
      expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
    } finally {
      server.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

it('derives root identity from bounded first-record provenance, independently of latest input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-origin-'))
  const transcriptPath = join(dir, 'transcript.jsonl')
  const server = attestFixtureHookContext(new AgentHookServer())
  try {
    const accepts = (first: unknown, lastUserInput?: unknown) => {
      writeFileSync(transcriptPath, jsonl(first, ROOT_ORIGIN))
      return normalized(hook(transcriptPath, ROOT, { lastUserInput }))
    }
    for (const first of [CHILD_ORIGIN, { source: 'USER', type: 'REQUEST' }, {}, null]) {
      const event = accepts(first, 'nonempty input grants no authority')
      expect(event.providerSession).toBeUndefined()
      server.ingestRemote(event, null)
      expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
    }
    for (const lastUserInput of ['Reply with OK.', '', undefined, null]) {
      expect(accepts(ROOT_ORIGIN, lastUserInput).providerSession?.id).toBe(ROOT)
    }
    const state = createHookListenerState()
    for (const text of [
      '',
      '{"source":"USER_EXPLICIT"',
      `malformed\n${JSON.stringify(ROOT_ORIGIN)}`,
      jsonl({ ...ROOT_ORIGIN, content: 'x'.repeat(TRANSCRIPT_MAX_SCAN_BYTES) })
    ]) {
      writeFileSync(transcriptPath, text)
      expect(normalized(hook(transcriptPath), state).providerSession).toBeUndefined()
    }
    rmSync(transcriptPath)
    expect(normalized(hook(transcriptPath), state).providerSession).toBeUndefined()
    writeFileSync(transcriptPath, jsonl(ROOT_ORIGIN))
    expect(normalized(hook(dir), state).providerSession).toBeUndefined()
    const root = normalized(hook(transcriptPath), state)
    expect(root.providerSession?.id).toBe(ROOT)
    server.ingestRemote(root, null)
    expect(remoteRefusals(server)).toBe(1)
    expectNoResume(server)
    rmSync(transcriptPath)
    server.ingestRemote(
      normalized(hook(transcriptPath, ROOT, { hook_event_name: 'Stop', fullyIdle: true }), state),
      null
    )
    expectNoResume(server)
    server.ingestTerminalStatus({
      paneKey: PANE,
      worktreeId: 'wt-1',
      origin: 'process',
      payload: { state: 'working', prompt: '', agentType: 'antigravity' }
    })
    server.ingestRemote(normalized(hook(transcriptPath, CHILD)), null)
    expect(server.getStatusSnapshot()[0]?.providerSession).toBeUndefined()
  } finally {
    server.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
