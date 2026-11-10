import { readSavedStatus } from '../persistence/last-status.test-fixtures'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../../agent-hook-server'
import type { probeAgentProcessPresence } from '../../../../../shared/agent-status/process/agent-process-presence-probe'
import { buildBody, GOOD_PANE, PANE, postHookEvent } from '../server.test-fixtures'

const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>(async () => 'live'))
vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
vi.mock('../../../../../shared/agent-status/process/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: probe
}))

const OLD = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FORK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

let root: string
let projectDir: string
const servers: AgentHookServer[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-claude-continuation-'))
  projectDir = join(root, 'claude', 'projects', '-work-repo')
  mkdirSync(projectDir, { recursive: true })
})

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  rmSync(root, { recursive: true, force: true })
  probe.mockReset().mockResolvedValue('live')
  vi.useRealTimers()
})

function transcript(sessionId: string, extra = ''): string {
  const transcriptPath = join(projectDir, `${sessionId}.jsonl`)
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({ type: 'user', sessionId, uuid: 'u1', cwd: '/work/repo' })}\n${extra}`
  )
  return transcriptPath
}

function forkOldIntoJob(): { oldPath: string; forkPath: string } {
  const pointer = { type: 'continued-in', sessionId: OLD, continuedInSessionId: FORK }
  return {
    oldPath: transcript(OLD, `${JSON.stringify(pointer)}\n`),
    forkPath: transcript(FORK)
  }
}

async function createServer(): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath: join(root, 'orca') })
  server.setHookContextSnapshotReader(async (envelope) => {
    if (envelope.paneKey !== PANE && envelope.paneKey !== GOOD_PANE) {
      return null
    }
    return {
      executionHostId: 'local',
      paneKey: envelope.paneKey,
      worktreeId: 'wt-1',
      ptyId: `fixture-pty-${envelope.paneKey}`,
      incarnationId: 'fixture-generation',
      launchTokenHash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      cwd: '/work/repo',
      reportedCwd:
        typeof envelope.hookPayloadRecord.cwd === 'string' ? envelope.hookPayloadRecord.cwd : ''
    }
  })
  server.setHookRootEvidenceReader(async () => ({ verdict: 'root', binding: 'fixture-generation' }))
  return server
}

async function prompt(server: AgentHookServer, paneKey: string, sessionId: string, path: string) {
  const [tabId] = paneKey.split(':')
  const response = await postHookEvent(
    server,
    buildBody(
      {
        hook_event_name: 'UserPromptSubmit',
        session_id: sessionId,
        transcript_path: path,
        cwd: '/work/repo',
        prompt: 'keep going'
      },
      {
        paneKey,
        tabId,
        launchToken: 'abc',
        agentProcess: JSON.stringify({
          pid: paneKey === PANE ? 4001 : 4002,
          platform: process.platform,
          startTime: tabId
        })
      }
    )
  )
  expect(response.status).toBe(204)
}

function row(server: AgentHookServer, paneKey = PANE) {
  return server.getStatusSnapshot().find((entry) => entry.paneKey === paneKey)
}

describe('Claude session continued into a daemon job', () => {
  it('does not mint durable fork ownership from an unverified resume and a transcript pointer', async () => {
    const server = await createServer()
    const { oldPath } = forkOldIntoJob()
    server.recordLaunchResumeIdentity({
      paneKey: PANE,
      worktreeId: 'wt-1',
      agentType: 'claude',
      providerSession: { key: 'session_id', id: OLD, transcriptPath: oldPath },
      launchedAt: 1
    })
    await prompt(server, PANE, OLD, oldPath)
    await server.checkAgentPresence(PANE)
    expect(row(server)?.providerSession?.id).toBe(OLD)
    server.clearPaneState(PANE)
    expect(server.flushResumeIdentityCheckpoint()).toBe(true)
    const persisted = JSON.parse(readSavedStatus(server.lastStatusPath!))
    expect(persisted.entries[PANE]?.providerSession?.id).toBe(OLD)
  })

  it('keeps observed ownership when its transcript alone names a fork', async () => {
    const server = await createServer()
    const { oldPath } = forkOldIntoJob()
    await prompt(server, PANE, OLD, oldPath)
    const before = row(server)
    expect(before?.providerSession).toMatchObject({ id: OLD, transcriptPath: oldPath })

    await server.checkAgentPresence(PANE)

    const after = row(server)
    expect(after?.providerSession).toEqual({
      key: 'session_id',
      id: OLD,
      transcriptPath: oldPath
    })
    expect(after?.state).toBe(before?.state)
    expect(after?.prompt).toBe(before?.prompt)
    server.flushStatusPersistSync()
    const persisted = JSON.parse(
      readSavedStatus(join(root, 'orca', 'agent-hooks', 'last-status.json'))
    )
    expect(persisted.entries[PANE].providerSession.id).toBe(OLD)
  })

  it('does not claim a fork that another pane already reports', async () => {
    const server = await createServer()
    const { oldPath, forkPath } = forkOldIntoJob()
    await prompt(server, PANE, OLD, oldPath)
    await prompt(server, GOOD_PANE, FORK, forkPath)
    expect(row(server, GOOD_PANE)?.providerSession?.id).toBe(FORK)

    await server.checkAgentPresence(PANE)

    expect(row(server)?.providerSession?.id).toBe(OLD)
    expect(row(server, GOOD_PANE)?.providerSession?.id).toBe(FORK)
  })
})
