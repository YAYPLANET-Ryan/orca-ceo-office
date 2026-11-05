import { mkdtempSync, rmSync } from 'node:fs'
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
    server.recordRuntimeResumeIdentity(delayed)
    expect(server.getStatusSnapshotForPane(PANE)[0].providerSession?.id).toBe('newer-conversation')
  })

  it('reports an unknown outcome when the durable write cannot complete', async () => {
    const { server } = await open()
    const internals = server as unknown as { lastStatusFilePath: string }
    const original = internals.lastStatusFilePath
    internals.lastStatusFilePath = join(original, 'impossible-child.json')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => server.recordRuntimeResumeIdentity(checkpoint('codex'))).toThrow(
        expect.objectContaining({ agentSessionOperationOutcome: 'unknown' })
      )
    } finally {
      internals.lastStatusFilePath = original
      warn.mockRestore()
    }
  })
})
