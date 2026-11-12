import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import { createHookListenerState } from '../../../../../../shared/agent-hook-listener/listener-state'
import { buildRelayHookEnvelope } from '../../../../../../wsl-guest/agent-hook-envelope-build'
import { AgentHookServer, _internals } from '../../../agent-hook-server'
import { PANE, buildBody, postHookEvent } from '../../server.test-fixtures'
import { attestFixtureHookContext } from '../../attested-hook-context.test-fixtures'

vi.mock('../../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

// Shapes captured from a live Codex 0.166 run.
const QUESTIONS = {
  questions: [
    { title: 'Which database should the probe use?', options: ['Postgres', 'SQLite', 'MySQL'] },
    { title: 'What should the probe name the new table?' }
  ]
}
const ASK = {
  hook_event_name: 'PreToolUse',
  turn_id: 'turn-1',
  tool_name: 'request_user_input_async',
  tool_input: QUESTIONS,
  tool_use_id: 'call_3_1'
}
const ACCEPTED = {
  ...ASK,
  hook_event_name: 'PostToolUse',
  tool_response: '{"accepted":true}'
}
const reply = (index: number) => ({
  hook_event_name: 'UserPromptSubmit',
  turn_id: 'turn-1',
  prompt: `<send_user_message_question_reply>\n${JSON.stringify([
    {
      answer: 'SQLite',
      question: QUESTIONS.questions[index]!.title,
      questionItemId: JSON.stringify(['request_user_input_async', 'call_3_1', index])
    }
  ])}\n</send_user_message_question_reply>`
})

beforeEach(() => {
  _internals.resetCachesForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// The execution host normalizes each hook, then main ingests the relayed row, as for SSH and WSL.
// Fork 6d65165647: main refuses relayed Codex status without attestation, so the relay pane
// checks the host's normalized rows and main's refusal.
function relayedCodexPane() {
  const host = createHookListenerState()
  const server = attestFixtureHookContext(new AgentHookServer())
  let relayed = 0
  return {
    report(payload: Record<string, unknown>) {
      const event = normalizeHookPayload(
        host,
        'codex',
        buildBody(payload, { worktreeId: 'folder-workspace' }),
        'production'
      )
      if (!event) {
        throw new Error('Expected a Codex hook event')
      }
      server.ingestRemote(buildRelayHookEnvelope(event, 'codex'), 'wsl:Ubuntu')
      relayed += 1
      expect(server.getContextIntegrityRejections()).toMatchObject({
        remote_context_attestation_unavailable: relayed
      })
      expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
      return event.payload
    }
  }
}

// A local Codex pane posts the same hooks to main from its attested PTY.
async function localCodexPane() {
  const server = attestFixtureHookContext(new AgentHookServer())
  await server.start({ env: 'production' })
  return {
    server,
    async report(payload: Record<string, unknown>) {
      const response = await postHookEvent(
        server,
        buildBody(payload, { worktreeId: 'folder-workspace' }),
        '/hook/codex'
      )
      expect(response.status).toBe(204)
      return server.getStatusSnapshotForPane(PANE)[0]
    }
  }
}

const waitingOnQuestion = {
  state: 'waiting',
  toolName: 'request_user_input_async',
  interactivePrompt: JSON.stringify(QUESTIONS)
}

describe('Codex async questions', () => {
  it('waits on an open question through the turn until every question is answered', async () => {
    const pane = await localCodexPane()
    try {
      await pane.report({
        hook_event_name: 'UserPromptSubmit',
        turn_id: 'turn-1',
        prompt: 'Set up a db'
      })

      expect(await pane.report(ASK)).toMatchObject(waitingOnQuestion)
      // Codex accepts the call at once and keeps working; the question is still open.
      expect(await pane.report(ACCEPTED)).toMatchObject(waitingOnQuestion)
      await pane.report({ hook_event_name: 'PreToolUse', turn_id: 'turn-1', tool_name: 'Bash' })
      // An approval on screen wins over the open question.
      const approval = await pane.report({
        hook_event_name: 'PermissionRequest',
        turn_id: 'turn-1',
        tool_name: 'Bash',
        tool_input: { command: 'pnpm tc' }
      })
      expect(approval?.state).toBe('waiting')
      expect(approval?.interactivePrompt).toContain('"approval"')
      await pane.report({ hook_event_name: 'PostToolUse', turn_id: 'turn-1', tool_name: 'Bash' })
      expect(await pane.report(reply(0))).toMatchObject(waitingOnQuestion)

      const answered = await pane.report(reply(1))
      expect(answered).toMatchObject({ state: 'working' })
      expect(answered?.interactivePrompt).toBeUndefined()
    } finally {
      pane.server.stop()
    }
  })

  it('keeps the open question on the execution host while main refuses the relayed rows', () => {
    const pane = relayedCodexPane()
    pane.report({ hook_event_name: 'UserPromptSubmit', turn_id: 'turn-1', prompt: 'Set up a db' })
    expect(pane.report(ASK)).toMatchObject(waitingOnQuestion)
    expect(pane.report(ACCEPTED)).toMatchObject(waitingOnQuestion)
    expect(pane.report(reply(0))).toMatchObject(waitingOnQuestion)
    const answered = pane.report(reply(1))
    expect(answered).toMatchObject({ state: 'working' })
    expect(answered.interactivePrompt).toBeUndefined()
  })
})
