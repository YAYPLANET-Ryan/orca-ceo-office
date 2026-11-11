import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../../../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests
} from '../../../../../shared/agent-hook-listener/listener-state'
import { buildRelayHookEnvelope } from '../../../../../wsl-guest/agent-hook-envelope-build'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { PANE, buildBody } from '../server.test-fixtures'

import { attestFixtureHookContext } from '../attested-hook-context.test-fixtures'
vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))

const QUESTIONS = {
  questions: [
    {
      id: 'scope',
      header: 'Scope',
      question: 'Which scope should I use?',
      options: [{ label: 'Current workspace', description: 'Update the current workspace.' }]
    }
  ]
}

beforeEach(() => {
  _internals.resetCachesForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function remoteCodex() {
  const host = createHookListenerState()
  const server = attestFixtureHookContext(new AgentHookServer())
  return {
    server,
    report(payload: Record<string, unknown>, legacy = false) {
      const event = normalizeHookPayload(
        host,
        'codex',
        buildBody(payload, { worktreeId: 'folder-workspace' }),
        'production'
      )
      if (!event) {
        throw new Error('Expected a Codex hook event')
      }
      seedLegacyAgentStatusForTests(host, event)
      const { mainAgent: _mainAgent, ...legacyPayload } = event.payload
      server.ingestRemote(
        buildRelayHookEnvelope(
          { ...event, payload: legacy ? legacyPayload : event.payload },
          'codex'
        ),
        'wsl:Ubuntu'
      )
      return server.getStatusSnapshotForPane(PANE)[0]
    }
  }
}

// Fork 6d65165647: relayed Claude/Codex status is refused without attestation.
const REMOTE_REFUSAL = 'remote_context_attestation_unavailable'

describe('remote Codex questions', () => {
  it.each([false, true])(
    'keeps a host question waiting until its answer (legacy relay: %s)',
    (legacy) => {
      const pane = remoteCodex()
      const hooks = [
        { hook_event_name: 'UserPromptSubmit', prompt: 'Update this workspace' },
        {
          hook_event_name: 'PreToolUse',
          tool_name: 'request_user_input',
          tool_input: QUESTIONS,
          tool_use_id: 'question-1'
        },
        {
          hook_event_name: 'PostToolUse',
          tool_name: 'request_user_input',
          tool_input: QUESTIONS,
          tool_response: '{"answers":{"scope":{"answers":["Current workspace"]}}}',
          tool_use_id: 'question-1'
        },
        { hook_event_name: 'Stop' }
      ]
      for (const hook of hooks) {
        expect(pane.report(hook, legacy)).toBeUndefined()
      }
      expect(pane.server.getStatusSnapshot()).toEqual([])
      expect(pane.server.getContextIntegrityRejections()).toEqual({
        [REMOTE_REFUSAL]: hooks.length
      })
    }
  )

  it('does not mistake a waiting child for a root question on an ordinary tool call', () => {
    const pane = remoteCodex()
    pane.report({ hook_event_name: 'UserPromptSubmit', prompt: 'Run the checks' })
    pane.report({ hook_event_name: 'SubagentStart', agent_id: 'child' })
    pane.report({
      hook_event_name: 'PreToolUse',
      agent_id: 'child',
      tool_name: 'request_user_input',
      tool_input: QUESTIONS
    })

    expect(
      pane.report({ hook_event_name: 'PreToolUse', tool_name: 'exec_command' })
    ).toBeUndefined()
    expect(pane.server.getStatusSnapshot()).toEqual([])
    expect(pane.server.getContextIntegrityRejections()).toEqual({ [REMOTE_REFUSAL]: 4 })
  })
})
