import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentHookServer } from './server/agent-hook-server'
import { PANE } from './server/testing/server.test-fixtures'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

it('reports unopened and stopped hook diagnostics as unavailable rather than a clean host', () => {
  const server = new AgentHookServer()
  expect(server.getContextIntegritySummary()).toEqual({
    version: 1,
    unverifiedCount: 0,
    overflowCount: 0,
    durability: 'memory-only',
    verification: 'unavailable'
  })
  server.stop()
  expect(server.getContextIntegritySummary().verification).toBe('unavailable')
})

function removeOwnedFixture(root: string): void {
  if (
    dirname(resolve(root)) !== resolve(tmpdir()) ||
    !basename(root).startsWith('orca-server-quarantine-')
  ) {
    throw new Error('Refusing cleanup outside own server fixture')
  }
  rmSync(root, { recursive: true, force: true })
}

it('does not report ownership verification ready merely because diagnostic storage opened', () => {
  class OpenDiagnosticStorage extends AgentHookServer {
    openStorage(file: string): void {
      this.contextQuarantine.open(file)
    }
  }
  const root = mkdtempSync(join(tmpdir(), 'orca-server-quarantine-'))
  const server = new OpenDiagnosticStorage()
  try {
    server.openStorage(join(root, 'quarantine.json'))
    expect(server.getContextQuarantineSnapshot().durability).toBe('saved')
    expect(server.getContextIntegritySummary().verification).toBe('unavailable')
  } finally {
    server.stop()
    removeOwnedFixture(root)
  }
})

it('retains unknown resume diagnostics after server restart without promoting a provider identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-server-quarantine-'))
  const server = new AgentHookServer()
  const restarted = new AgentHookServer()
  try {
    await server.start({ userDataPath: root, env: 'production' })
    expect(
      server.recordLaunchResumeIdentity({
        paneKey: PANE,
        worktreeId: 'synthetic-workspace',
        agentType: 'codex',
        providerSession: { key: 'session_id', id: 'unverified-original' },
        launchedAt: 1
      })
    ).toBe('recorded')
    expect(server.getProviderSessionIdentities()).toEqual([])
    expect(server.getContextIntegritySummary()).toMatchObject({
      version: 1,
      unverifiedCount: 1,
      overflowCount: 0,
      verification: 'unavailable'
    })
    expect(Object.keys(server.getContextIntegritySummary()).sort()).toEqual([
      'durability',
      'overflowCount',
      'unverifiedCount',
      'verification',
      'version'
    ])
    expect(server.getContextQuarantineSnapshot().entries[0]?.reason).toBe(
      'launch_context_attestation_unavailable'
    )
    server.stop()
    const bytes = readFileSync(join(root, 'agent-hooks', 'context-quarantine-v1.json'), 'utf8')
    expect(bytes).not.toContain('unverified-original')
    expect(bytes).not.toContain(PANE)
    expect(bytes).not.toContain('synthetic-workspace')
    await restarted.start({ userDataPath: root, env: 'production' })
    expect(restarted.getContextQuarantineSnapshot().entries[0]?.count).toBe(1)
    expect(restarted.getProviderSessionIdentities()).toEqual([])
  } finally {
    server.stop()
    restarted.stop()
    removeOwnedFixture(root)
  }
})
