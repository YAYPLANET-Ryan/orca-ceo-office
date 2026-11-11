import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PANE } from '../server.test-fixtures'

import '../../../../../shared/agent-hook-listener/presence/hook-process-root-evidence'

import '../../../../../wsl-guest/agent-hook-server'
import '../../../../../wsl-guest/relay-pane-root'
import '../../../observations/local-tmux-managed-pty'

import {
  NOW,
  CLAUDE,
  NESTED,
  SHIM,
  TMUX,
  TMUX_HINT,
  io,
  live,
  probe,
  paths,
  attempts,
  codexTurn,
  capture,
  createServer,
  runningPane,
  hook,
  observe,
  refusals,
  slowRoot,
  settled,
  type RootTestServer,
  registerRootTestHarness,
  type Proc
} from './server-hook-root.test-fixtures'

vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: vi.fn()
}))

registerRootTestHarness()

// Fork 6d65165647: local Claude/Codex hooks without root evidence (fallbacks, tmux sessions the
// pane does not show, answers past the admission deadline) and terminal reports are refused
// without attestation, so no fallback or status-only record is ever minted for them.

// Orca's own agent-teams launch sets this synthetic TMUX; its Claudes run in no tmux server.
const AGENT_TEAMS_HINT = '%1 /tmp/orca-claude-agent-teams/team-x'
const unboundRoot = () => {
  runningPane(49969, CLAUDE)
  io.resolveRoot.mockResolvedValueOnce(null)
}

it('rechecks Antigravity on its next turn when its process becomes the pane foreground', async () => {
  const server = await createServer()
  runningPane(49990, [49969, 101, 49969, 'agy', 'S'], [49990, 101, 49990, 'claude', 'S+'])
  await hook(server, 'PreInvocation', { source: 'antigravity', prompt: 'Not foreground' })
  expect(server.row()).toBeUndefined()
  expect(attempts()).toBe(1)
  runningPane(49969, [49969, 101, 49969, 'agy', 'S+'])
  await hook(server, 'PreToolUse', { source: 'antigravity' })
  expect(server.row()).toBeUndefined()
  expect(attempts()).toBe(1)
  await hook(server, 'PreInvocation', { source: 'antigravity', prompt: 'Foreground task' })
  expect(server.row()).toMatchObject({ agentType: 'antigravity', prompt: 'Foreground task' })
  expect(server.presence()).toMatchObject({ agent: 'antigravity', process: capture(49969) })
})

describe('an empty pane whose first hook cannot be proved', () => {
  it.each<[string, () => void, string?]>([
    ['a spawning shim', () => runningPane(49960, ...SHIM)],
    [
      'an ancestor whose argv is unreadable',
      () =>
        runningPane(
          49960,
          [49960, 101, 49960, '(node)', 'S+'],
          [49969, 49960, 49960, 'claude', 'S+']
        )
    ],
    ['a pane whose root its PTY owner has not named yet', unboundRoot],
    ['an agent-teams Claude whose root is not named yet', unboundRoot, AGENT_TEAMS_HINT]
  ])(
    'records %s as main does, as a fallback its own exit retires once',
    async (_name, setup, tmuxPane) => {
      const server = await createServer()
      setup()
      // A trust prompt is an observation, never ownership: the pane is still empty.
      observe(server, 'waiting')
      await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Task', tmuxPane })
      // The unprovable first hook is refused instead of recorded as a fallback.
      expect(refusals(server, 'process_generation_unconfirmed')).toBe(1)
      expect(server.row()).toBeUndefined()
      expect(server.presence()).toBeUndefined()
      expect(server.hasVerifiableAgentProcess(PANE)).toBe(false)
      // Another provider's process-less hooks are refused too.
      await codexTurn(server, 'Codex task')
      expect(server.row()).toBeUndefined()
      expect(refusals(server, 'process_generation_unconfirmed')).toBe(2)
      // Terminal reports never turn it into proof; its own next hook is read again.
      observe(server, 'working')
      expect(refusals(server, 'terminal_context_attestation_unavailable')).toBe(2)
      await hook(server, 'PostToolUse', { session: 'session-a' })
      const bound = setup === unboundRoot
      if (bound) {
        // The PTY owner has named the root by now, so the next hook proves it.
        expect(server.presence()).toMatchObject({ process: capture(49969), session: 'session-a' })
        expect(server.presence()?.fallback).toBeUndefined()
      } else {
        expect(server.presence()).toBeUndefined()
      }
      await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
      await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
      // Only a proved owner's exit retires it, once.
      expect(server.exits).toBe(bound ? 1 : 0)
      expect(refusals(server, 'process_generation_unconfirmed')).toBe(bound ? 2 : 5)
    }
  )

  it('records a first hook whose evidence misses its answer deadline, then upgrades it', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE)
    const release = slowRoot()
    const started = performance.now()
    await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Task' })
    expect(performance.now() - started).toBeLessThan(700)
    // Evidence past the admission deadline refuses the hook; its late answer records nothing.
    expect(refusals(server, 'context_evidence_unavailable')).toBe(1)
    expect(server.presence()).toBeUndefined()
    release()
    await settled()
    expect(server.presence()).toBeUndefined()
    expect(server.row()).toBeUndefined()
    // The next hook, answered in time, is admitted as the pane's root.
    await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Task' })
    expect(server.presence()).toMatchObject({ process: capture(49969), session: 'session-a' })
    expect(server.presence()?.fallback).toBeUndefined()
    expect(server.row()).toMatchObject({ state: 'working', prompt: 'Task' })
  })

  it.each([['running'], ['restored']])(
    'lets the pane’s proved root replace a %s fallback that is still live',
    async (mode) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-root-fallback-'))
      paths.push(userDataPath)
      let server = await createServer(userDataPath)
      // A nested run reports first while the pane's binding is not hydrated yet.
      runningPane(
        49970,
        [49970, 101, 49970, 'claude', 'S+'],
        [49975, 49970, 49975, 'zsh -c claude -p x', 'Ss', '??'],
        [49969, 49975, 49975, 'claude -p x', 'S', '??']
      )
      io.resolveRoot.mockResolvedValueOnce(null)
      await hook(server, 'UserPromptSubmit', { session: 'nested', prompt: 'Nested' })
      // The nested run is refused rather than recorded as a fallback, so none is restored.
      expect(refusals(server, 'process_generation_unconfirmed')).toBe(1)
      expect(server.presence()).toBeUndefined()
      if (mode === 'restored') {
        server.flushStatusPersistSync()
        server.stop()
        server = await createServer(userDataPath)
        expect(server.presence()).toBeUndefined()
      }
      await hook(server, 'PostToolUse', { session: 'session-a', pid: 49970 })
      expect(server.presence()).toMatchObject({ process: capture(49970), session: 'session-a' })
      expect(server.presence()?.fallback).toBeUndefined()
      // The child's later exit is refused before it can end the pane.
      await hook(server, 'SessionEnd', { session: 'nested', reason: 'prompt_input_exit' })
      expect(server.exits).toBe(0)
      // A restarted server counts only its own refusals.
      expect(refusals(server, 'process_generation_unconfirmed')).toBe(mode === 'restored' ? 1 : 2)
    }
  )
})

describe('a Claude in a tmux session the pane does not show', () => {
  it.each([
    ['with', TMUX_HINT],
    ['without', undefined]
  ])(
    'shows its status, session and Done without recording a process, %s the hook’s hint',
    async (_name, tmuxPane) => {
      const server = await createServer()
      runningPane(101, ...TMUX)
      const sender = { session: 'tmux', pid: 4043, tmuxPane }
      // A sender the pane's root cannot be proved for is refused, status included.
      await hook(server, 'UserPromptSubmit', { ...sender, prompt: 'In tmux' })
      expect(server.row()).toBeUndefined()
      await hook(server, 'Stop', sender)
      expect(server.row()).toBeUndefined()
      expect(server.presence()).toBeUndefined()
      await hook(server, 'SessionEnd', { ...sender, reason: 'prompt_input_exit' })
      expect(server.exits).toBe(0)
      expect(refusals(server, 'process_generation_unconfirmed')).toBe(3)
    }
  )

  it('withdraws a fallback recorded before an unhinted read found the session', async () => {
    const server = await createServer()
    runningPane(101, ...TMUX)
    const release = slowRoot()
    await hook(server, 'UserPromptSubmit', { session: 'tmux', pid: 4043, prompt: 'In tmux' })
    // Refused at the admission deadline; no fallback is recorded to withdraw.
    expect(refusals(server, 'context_evidence_unavailable')).toBe(1)
    expect(server.presence()).toBeUndefined()
    release()
    await settled()
    expect(server.presence()).toBeUndefined()
    expect(server.row()).toBeUndefined()
    expect(server.exits).toBe(0)
  })
})

// The late answer lands on an unproven record, or on the status-only record a hinted first hook
// minted into an empty pane while the read was pending.
const lateStarts: [string, (server: RootTestServer) => Promise<void>, string?][] = [
  [
    'an unproven record',
    (server) => hook(server, 'UserPromptSubmit', { session: 'older', pid: null, prompt: 'Old' })
  ],
  ['an empty pane’s status-only first hook', async () => {}, TMUX_HINT]
]

describe('a late answer on a slow host', () => {
  it.each(lateStarts)(
    'heals %s as the root lands, with no later hook or replayed prompt',
    async (_name, start, tmuxPane) => {
      const server = await createServer()
      runningPane(49969, CLAUDE)
      await start(server)
      const release = slowRoot()
      await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'New task', tmuxPane })
      expect(server.presence()?.process).toBeUndefined()
      // The hook was refused at its deadline, so the late root heals nothing.
      expect(refusals(server, 'context_evidence_unavailable')).toBe(1)
      release()
      await settled()
      expect(server.presence()).toBeUndefined()
      expect(server.row()).toBeUndefined()
      vi.clearAllMocks()
      vi.setSystemTime(NOW + 15_000)
      // The owner's next hooks prove its root, each with its own admission read.
      await hook(server, 'PostToolUse', { session: 'session-a' })
      await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Next' })
      expect(server.presence()).toMatchObject({ process: capture(49969), session: 'session-a' })
      expect(server.row()).toMatchObject({ state: 'working', prompt: 'Next' })
      expect(attempts()).toBe(2)
    }
  )

  it.each(lateStarts)(
    'retires %s on a late exit proof once, with no later hook',
    async (_name, start, tmuxPane) => {
      const server = await createServer()
      runningPane(49969, CLAUDE)
      await start(server)
      const release = slowRoot()
      if (tmuxPane) {
        await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Task', tmuxPane })
      }
      await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
      expect(server.exits).toBe(0)
      // The exit is refused at its deadline, so the late proof owes nothing.
      expect(refusals(server, 'context_evidence_unavailable')).toBe(1)
      observe(server, 'working')
      release()
      await settled()
      expect(server.exits).toBe(0)
      expect(server.presence()).toBeUndefined()
    }
  )

  it.each<[string, (server: RootTestServer) => Promise<void> | void]>([
    ['the pane closed', (server) => server.clearPaneState(PANE, { forgetAgentExit: true })],
    // The exiting process left the pane's job before its membership could be read.
    ['the job changed', () => runningPane(101)]
  ])('owes no exit once %s while the answer was pending', async (_name, change) => {
    const server = await createServer()
    runningPane(49969, CLAUDE)
    await hook(server, 'UserPromptSubmit', { session: 'older', pid: null, prompt: 'Old task' })
    const release = slowRoot()
    await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
    await change(server)
    release()
    await settled()
    expect(server.exits).toBe(0)
  })

  it('owes no exit to a record another process minted after the exit was seen', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE)
    const release = slowRoot()
    await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
    await hook(server, 'UserPromptSubmit', { session: 'other', pid: null, prompt: 'Other' })
    release()
    await settled()
    expect(server.exits).toBe(0)
    // Neither the late exit nor the process-less record is admitted.
    expect(server.getContextIntegrityRejections()).toMatchObject({
      context_evidence_unavailable: 1,
      process_generation_unconfirmed: 1
    })
    expect(server.presence()).toBeUndefined()
  })
})

describe('a suspended owner', () => {
  function suspend(): void {
    probe.mockImplementation(async (identity, _read, _platform, onSuspension) => {
      if (identity?.pid === 49969) {
        onSuspension?.(true)
        return 'unverifiable'
      }
      return identity && live.has(identity.pid) ? 'live' : 'unverifiable'
    })
  }

  it.each<[string, Proc[], number]>([
    ['a nested run', NESTED, 49980],
    [
      'an editor terminal’s process',
      [
        [60000, 1, 60000, '/Applications/Code.app/Contents/MacOS/Code Helper', 'S', '??'],
        [60001, 60000, 60001, 'claude', 'S+', 'ttys009']
      ],
      60001
    ],
    [
      'a process whose lineage is unreadable',
      [
        [49990, 101, 49990, '(node)', 'S'],
        [49991, 49990, 49990, 'claude', 'S']
      ],
      49991
    ]
  ])('keeps %s from replacing it, before any provider fold', async (_name, procs, pid) => {
    const server = await createServer()
    runningPane(49969, CLAUDE, ...procs)
    await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Parent task' })
    suspend()
    await server.checkAgentPresence(PANE)
    expect(server.presence()?.suspended).toBe(true)
    const before = attempts()
    await hook(server, 'UserPromptSubmit', { session: 'child', pid, prompt: 'Child task' })
    await hook(server, 'SessionEnd', { session: 'child', pid, reason: 'prompt_input_exit' })
    expect(attempts()).toBeGreaterThan(before)
    expect(server.presence()).toMatchObject({
      process: capture(49969),
      session: 'session-a',
      suspended: true
    })
    expect(server.row()).toMatchObject({ prompt: 'Parent task' })
    expect(server.foldedPrompt()).toBe('Parent task')
    expect(server.exits).toBe(0)
  })

  it('yields to the pane’s new foreground agent, whose record the stopped one cannot end', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE)
    await hook(server, 'SessionStart', { session: 'session-a' })
    suspend()
    await server.checkAgentPresence(PANE)
    runningPane(49970, [49969, 101, 49969, 'claude', 'T'], [49970, 101, 49970, 'claude', 'S+'])
    await hook(server, 'SessionStart', { session: 'session-b', pid: 49970 })
    expect(server.presence()).toMatchObject({ process: capture(49970), session: 'session-b' })
    await hook(server, 'SessionEnd', { session: 'session-a', reason: 'prompt_input_exit' })
    expect(server.presence()).toMatchObject({ process: capture(49970) })
    expect(server.exits).toBe(0)
  })

  it('lets its own unproven fallback resume after fg, still a fallback a proved root replaces', async () => {
    const server = await createServer()
    runningPane(49960, ...SHIM)
    await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Before' })
    await hook(server, 'Stop', { session: 'session-a' })
    // The shim's hooks are refused, so there is no fallback to suspend.
    expect(refusals(server, 'process_generation_unconfirmed')).toBe(2)
    suspend()
    await server.checkAgentPresence(PANE)
    expect(server.presence()).toBeUndefined()
    // fg: the same process posts its next turn, still unprovable.
    probe.mockImplementation(async (identity) =>
      identity && live.has(identity.pid) ? 'live' : 'unverifiable'
    )
    await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'After fg' })
    expect(refusals(server, 'process_generation_unconfirmed')).toBe(3)
    expect(server.row()).toBeUndefined()
    expect(server.presence()).toBeUndefined()
    runningPane(49969, CLAUDE)
    await hook(server, 'UserPromptSubmit', { session: 'session-a', prompt: 'Proved' })
    expect(server.presence()).toMatchObject({ process: capture(49969), session: 'session-a' })
    expect(server.presence()?.fallback).toBeUndefined()
  })
})

describe('an owner’s exit seen by a challenging hook', () => {
  it('keeps the proved exit when the challenger is refused', async () => {
    const server = await createServer()
    runningPane(49969, CLAUDE, ...NESTED)
    await hook(server, 'SessionStart', { session: 'session-a' })
    probe.mockImplementation(async (identity) =>
      identity?.pid === 49969
        ? 'exited'
        : identity && live.has(identity.pid)
          ? 'live'
          : 'unverifiable'
    )
    await hook(server, 'UserPromptSubmit', { session: 'nested', pid: 49980, prompt: 'nested' })
    expect(await server.checkAgentPresenceSince(PANE, NOW - 1)).toBe('exited')
  })
})
