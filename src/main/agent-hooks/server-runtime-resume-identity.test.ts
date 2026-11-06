import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from './server'
import { PANE } from './server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

const servers: AgentHookServer[] = []
const dirs: string[] = []
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

async function open(userDataPath = mkdtempSync(join(tmpdir(), 'orca-resume-identity-'))) {
  if (!dirs.includes(userDataPath)) {
    dirs.push(userDataPath)
  }
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ userDataPath })
  return { server, userDataPath }
}

function checkpoint(agent: 'codex' | 'claude', connectionId: string | null = null) {
  return {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent,
    connectionId,
    providerSession: { key: 'session_id' as const, id: `${agent}-original-id` },
    requestedAt: Date.now()
  }
}

describe('runtime resume identity checkpoint', () => {
  it.each(['codex', 'claude'] as const)(
    'survives restart without claiming a live %s turn',
    async (agent) => {
      const { server, userDataPath } = await open()
      const event = checkpoint(agent)
      const listener = vi.fn()
      server.setListener(listener)
      server.recordRuntimeResumeIdentity(event)
      expect(server.getStatusChangeSnapshot()).toEqual([])
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          providerSessionOnly: true,
          providerSession: event.providerSession,
          observation: expect.objectContaining({ origin: 'launch', kind: 'identity-only' })
        })
      )
      server.stop()
      const restarted = (await open(userDataPath)).server
      expect(restarted.getStatusSnapshotForPane(PANE)).toEqual([
        expect.objectContaining({
          providerSessionOnly: true,
          providerSession: event.providerSession
        })
      ])
      expect(restarted.getStatusChangeSnapshot()).toEqual([])
    }
  )

  it('keeps SSH routing on the durable identity', async () => {
    const { server, userDataPath } = await open()
    server.recordRuntimeResumeIdentity(checkpoint('codex', 'ssh-target-1'))
    server.stop()
    expect((await open(userDataPath)).server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      connectionId: 'ssh-target-1',
      worktreeId: 'wt-1'
    })
  })

  it('does not overwrite a newer identity with a delayed resume completion', async () => {
    const { server } = await open()
    const delayed = { ...checkpoint('codex'), requestedAt: Date.now() - 1000 }
    server.recordRuntimeResumeIdentity({
      ...checkpoint('codex'),
      providerSession: { key: 'session_id', id: 'newer-conversation' }
    })
    expect(() => server.recordRuntimeResumeIdentity(delayed)).toThrow('checkpoint_superseded')
    expect(server.getStatusSnapshotForPane(PANE)[0].providerSession?.id).toBe('newer-conversation')
  })

  it('merges an identity into an observed working row without an ID', async () => {
    const { server } = await open()
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      payload: { agentType: 'codex', state: 'working', prompt: '' }
    })
    server.recordRuntimeResumeIdentity({ ...checkpoint('codex'), requestedAt: Date.now() + 1 })
    expect(server.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      state: 'working',
      providerSession: { id: 'codex-original-id' }
    })
    expect(server.getStatusSnapshotForPane(PANE)[0].providerSessionOnly).not.toBe(true)
  })

  it('retains a checkpoint identity through process teardown and restart', async () => {
    const { server, userDataPath } = await open()
    server.recordRuntimeResumeIdentity(checkpoint('codex'))
    server.registerPaneKeyAlias('tab-1:1', PANE, 'pty-original')
    server.clearPaneKeyAliasesForPty('pty-original')
    server.retirePaneAuthority(PANE)
    server.clearPaneState(PANE)
    server.stop()
    const restarted = (await open(userDataPath)).server
    expect(restarted.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      providerSessionOnly: true,
      providerSession: { id: 'codex-original-id' }
    })
    expect(restarted.getStatusChangeSnapshot()).toEqual([])
  })

  it('keeps checkpoint identity after a live OSC observation and teardown', async () => {
    const { server, userDataPath } = await open()
    server.recordRuntimeResumeIdentity(checkpoint('codex'))
    server.ingestTerminalStatus({
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      connectionId: null,
      payload: { agentType: 'codex', state: 'working', prompt: '' }
    })
    expect(server.getStatusSnapshotForPane(PANE)[0].providerSession?.id).toBe('codex-original-id')
    server.clearPaneState(PANE)
    server.stop()
    const restarted = (await open(userDataPath)).server
    expect(restarted.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      providerSessionOnly: true,
      providerSession: { id: 'codex-original-id' }
    })
    expect(restarted.getStatusChangeSnapshot()).toEqual([])
  })

  it.each(
    (['dismiss', 'reconcile', 'checkpoint-teardown'] as const).flatMap((teardown) =>
      (['working', 'done'] as const).map((state) => ({ teardown, state }))
    )
  )(
    'does not attach a retained old identity to a new $state OSC turn after $teardown',
    async ({ teardown, state }) => {
      const { server } = await open()
      server.recordRuntimeResumeIdentity(checkpoint('codex'))
      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: null,
        payload: { agentType: 'codex', state: 'working', prompt: '' }
      })
      if (teardown === 'dismiss') {
        server.dropStatusEntry(PANE)
      } else if (teardown === 'reconcile') {
        server.reconcileEndedProcessForPaneKeys([PANE], { preserveResumeIdentity: true })
      } else {
        server.clearPaneState(PANE)
      }
      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: null,
        payload: { agentType: 'codex', state, prompt: '' }
      })
      expect(server.getStatusSnapshotForPane(PANE)[0].providerSession).toBeUndefined()
      expect(() =>
        server.recordRuntimeResumeIdentity({
          ...checkpoint('codex'),
          providerSession: { key: 'session_id', id: 'new-conversation' },
          requestedAt: Date.now() + 1
        })
      ).not.toThrow()
      expect(server.getStatusSnapshotForPane(PANE)[0].providerSession?.id).toBe('new-conversation')
    }
  )

  it('accepts a committed resume after pane retirement while preserving explicit tab fences', async () => {
    const { server } = await open()
    server.recordRuntimeResumeIdentity(checkpoint('codex'))
    server.retirePaneAuthority(PANE)
    expect(() =>
      server.recordRuntimeResumeIdentity({ ...checkpoint('codex'), requestedAt: Date.now() + 1 })
    ).not.toThrow()
    server.dropStatusEntriesByTabPrefix('tab-1')
    expect(() =>
      server.recordRuntimeResumeIdentity({ ...checkpoint('codex'), requestedAt: Date.now() + 2 })
    ).toThrow('checkpoint_superseded')
  })

  it('retains an authoritative replacement provider ID through teardown and restart', async () => {
    const { server, userDataPath } = await open()
    server.recordRuntimeResumeIdentity(checkpoint('codex', 'ssh-target-1'))
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        providerSession: { key: 'session_id', id: 'provider-replacement-id' },
        payload: { agentType: 'codex', state: 'working', prompt: '' }
      },
      'ssh-target-1'
    )
    server.clearPaneState(PANE)
    server.stop()
    expect(
      (await open(userDataPath)).server.getStatusSnapshotForPane(PANE)[0]?.providerSession?.id
    ).toBe('provider-replacement-id')
  })

  it.each(['teardown', 'restart'] as const)(
    'does not reuse a pending launch observation after %s',
    async (boundary) => {
      const { server, userDataPath } = await open()
      server.recordRuntimeResumeIdentity(checkpoint('codex'))
      let current = server
      if (boundary === 'teardown') {
        server.clearPaneState(PANE)
      } else {
        server.stop()
        current = (await open(userDataPath)).server
      }
      current.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: null,
        payload: { agentType: 'codex', state: 'working', prompt: '' }
      })
      expect(current.getStatusSnapshotForPane(PANE)[0]?.providerSession).toBeUndefined()
    }
  )

  it('does not restore checkpoint identities after the user closes the tab', async () => {
    const { server, userDataPath } = await open()
    server.recordRuntimeResumeIdentity(checkpoint('codex'))
    server.dropStatusEntriesByTabPrefix('tab-1')
    server.clearPaneState(PANE)
    server.stop()
    expect((await open(userDataPath)).server.getStatusSnapshotForPane(PANE)).toEqual([])
  })

  it('retains a checkpoint identity after SSH transport loss and restart', async () => {
    const { server, userDataPath } = await open()
    server.recordRuntimeResumeIdentity(checkpoint('codex', 'ssh-target-1'))
    server.clearStatusEntriesForConnection('ssh-target-1')
    server.stop()
    const restarted = (await open(userDataPath)).server
    expect(restarted.getStatusSnapshotForPane(PANE)[0]).toMatchObject({
      providerSessionOnly: true,
      connectionId: 'ssh-target-1',
      providerSession: { id: 'codex-original-id' }
    })
    expect(restarted.getStatusChangeSnapshot()).toEqual([])
  })

  it('does not persist the process-local first-observation marker', async () => {
    const { server } = await open()
    server.recordRuntimeResumeIdentity(checkpoint('codex'))
    const path = (server as unknown as { lastStatusFilePath: string }).lastStatusFilePath
    const persisted = JSON.parse(readFileSync(path, 'utf8'))
    expect(persisted.entries[PANE]).not.toHaveProperty('runtimeResumePendingObservation')
  })

  it('reports an unknown outcome when the durable write cannot complete', async () => {
    const { server } = await open()
    server.retirePaneAuthority(PANE)
    const internals = server as unknown as { lastStatusFilePath: string }
    const original = internals.lastStatusFilePath
    internals.lastStatusFilePath = join(original, 'impossible-child.json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => server.recordRuntimeResumeIdentity(checkpoint('codex'))).toThrow(
        expect.objectContaining({ agentSessionOperationOutcome: 'unknown' })
      )
      server.ingestTerminalStatus({
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        connectionId: null,
        payload: { agentType: 'codex', state: 'working', prompt: '' }
      })
      expect(server.getStatusSnapshotForPane(PANE)[0].providerSessionOnly).toBe(true)
    } finally {
      internals.lastStatusFilePath = original
      warn.mockRestore()
    }
  })
})
