import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { AgentHookServer } from './server/agent-hook-server'
import { installLocalHookRootEvidence } from './observations/local-hook-root-evidence'
import { captureHookLaunchContext } from './hook-launch-context'
import { createLocalHookContextSnapshotReader } from './local-hook-context-snapshot'
import { stampPtySpawnPaneEnv } from '../ipc/pty/spawn-pane-env'
import { buildBody, PANE, postHookEvent } from './server/testing/server.test-fixtures'
import type { PtyProcessInfo } from '../providers/pty-process-info'

const inventory = vi.hoisted((): { rows: PtyProcessInfo[] } => ({ rows: [] }))
const native = vi.hoisted(
  (): {
    enabled: boolean
    rows: {
      pid: number
      ppid: number
      name: string
      command: string
      creationTimeMs: number
    }[]
    keys: Map<number, string>
  } => ({
    enabled: false,
    rows: [],
    keys: new Map<number, string>()
  })
)
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../ipc/pty/pane/key-state', () => ({
  getPtyIdForPaneKey: (pane: string) => (pane === PANE ? 'owned-pty' : undefined)
}))
vi.mock('../ipc/pty/provider/registry', () => ({
  getLocalPtyProvider: () => ({ listProcesses: async () => inventory.rows })
}))
vi.mock('../../shared/agent-hook-listener/presence/hook-process-root-evidence-reader', () => ({
  createLocalHookRootEvidenceReader: () => async () => ({ verdict: 'unknown' })
}))
vi.mock('../windows/windows-process-table', () => ({
  getWindowsProcessMetadataQueries: () =>
    native.enabled
      ? {
          getProcessCreationTimeKey: (pid: number) => native.keys.get(pid),
          getLoopbackTcpPeer: () => ({ pid: 1002, creationTimeKey: native.keys.get(1002) })
        }
      : null,
  readWindowsProcessCreationTime: (pid: number) =>
    native.rows.find((row) => row.pid === pid)?.creationTimeMs ?? null,
  readWindowsProcessTableFresh: async () => native.rows,
  readWindowsProcessTable: async () => native.rows,
  readWindowsProcessIdentityTableFresh: async () => native.rows,
  readWindowsProcessIdentityTable: async () => native.rows
}))

const servers: AgentHookServer[] = []
const roots: string[] = []

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  inventory.rows = []
  native.enabled = false
  native.rows = []
  native.keys.clear()
  for (const root of roots.splice(0)) {
    if (
      dirname(resolve(root)) !== resolve(tmpdir()) ||
      !basename(root).startsWith('orca-positive-context-')
    ) {
      throw new Error('Refusing cleanup outside owned fixture')
    }
    rmSync(root, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

async function preparedHost() {
  const root = mkdtempSync(join(tmpdir(), 'orca-positive-context-'))
  roots.push(root)
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath: root })
  const env = { ...server.buildPtyEnv(), ORCA_AGENT_LAUNCH_TOKEN: 'abc' }
  stampPtySpawnPaneEnv(env, {
    pane: { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1' },
    jcodeRuntimeDir: undefined,
    hasLaunchConfig: true
  })
  const context = captureHookLaunchContext(env, root)
  if (!context) {
    throw new Error('Host did not capture issued launch context')
  }
  const row: PtyProcessInfo = {
    id: 'owned-pty',
    incarnationId: 'generation',
    rootProcessId: 1000,
    rootProcessCreationKey: '133000000000000000',
    paneKey: PANE,
    worktreeId: 'wt-1',
    cwd: root,
    contextCwd: context.cwd,
    title: 'shell',
    launchTokenHash: context.launchTokenHash,
    ownerClientInstanceId: context.ownerClientInstanceId,
    paneBound: true,
    ownerClientAttached: true
  }
  return { root, server, env, row }
}

function envelope(cwd: string) {
  return {
    record: {},
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    hookPayloadRecord: { cwd },
    eventName: 'SessionStart'
  }
}

describe('host-issued hook context producers', () => {
  it.runIf(process.platform === 'win32').each(['claude', 'codex'] as const)(
    'admits a real-factory %s hook using the OS peer instead of its forged PID claim',
    async (provider) => {
      const { root, server, row } = await preparedHost()
      inventory.rows = [row]
      const epoch = 133000000000000000n
      native.enabled = true
      native.rows = [
        {
          pid: 1000,
          ppid: 1,
          name: 'powershell.exe',
          command: 'powershell.exe',
          creationTimeMs: 1655526400000
        },
        {
          pid: 1001,
          ppid: 1000,
          name: `${provider}.exe`,
          command: `C:\\apps\\${provider}.exe${provider === 'codex' ? ' --no-daemon' : ''}`,
          creationTimeMs: 1655526400001
        },
        {
          pid: 1002,
          ppid: 1001,
          name: 'orca-agent-hook.exe',
          command: 'orca-agent-hook.exe',
          creationTimeMs: 1655526400002
        }
      ]
      for (let index = 0; index < 3; index++) {
        native.keys.set(1000 + index, String(epoch + BigInt(index) * 10000n))
      }
      installLocalHookRootEvidence(server)
      expect(server.getContextIntegritySummary().verification).toBe('available')
      const id = '00000000-0000-4000-8000-000000000001'
      await postHookEvent(
        server,
        buildBody(
          { hook_event_name: 'SessionStart', source: 'startup', session_id: id, cwd: root },
          {
            launchToken: 'abc',
            agentProcess: JSON.stringify({ pid: 9999, platform: 'win32', startTime: 'forged' })
          }
        ),
        `/hook/${provider}`
      )
      expect(server.getContextIntegrityRejections()).toEqual({})
      expect(server.getProviderSessionIdentities()).toEqual([
        expect.objectContaining({ paneKey: PANE, worktreeId: 'wt-1', sessionId: id })
      ])
      native.enabled = false
      expect(server.getContextIntegritySummary().verification).toBe('unavailable')
    }
  )

  it('wires the actual main factory to the issuing listener before requiring process evidence', async () => {
    const { root, server, row } = await preparedHost()
    inventory.rows = [row]
    installLocalHookRootEvidence(server)
    await postHookEvent(
      server,
      buildBody(
        {
          hook_event_name: 'SessionStart',
          source: 'startup',
          session_id: '00000000-0000-4000-8000-000000000001',
          cwd: root
        },
        {
          launchToken: 'abc',
          agentProcess: JSON.stringify({ pid: 1001, platform: 'linux', startTime: 'fixture' })
        }
      )
    )
    expect(server.getContextIntegrityRejections()).toEqual({ process_generation_unconfirmed: 1 })
    expect(server.getProviderSessionIdentities()).toEqual([])
  })

  it('binds captured metadata to the owning listener while refusing a different profile', async () => {
    const { root, server, row } = await preparedHost()
    const read = createLocalHookContextSnapshotReader(
      async () => row,
      undefined,
      () => server.contextOwnerId
    )
    expect(await read(envelope(root))).toMatchObject({
      paneKey: PANE,
      worktreeId: 'wt-1',
      incarnationId: 'generation'
    })
    expect(
      await createLocalHookContextSnapshotReader(
        async () => row,
        undefined,
        'foreign-profile'
      )(envelope(root))
    ).toBeNull()
  })

  it('does not let mutable OSC cwd promote a different workspace', async () => {
    const { root, server, row } = await preparedHost()
    const other = resolve(root, '../other-workspace')
    const read = createLocalHookContextSnapshotReader(
      async () => ({ ...row, cwd: other }),
      undefined,
      () => server.contextOwnerId
    )
    expect(await read(envelope(root))).not.toBeNull()
    expect(await read(envelope(other))).toBeNull()
    expect(
      await createLocalHookContextSnapshotReader(
        async () => ({ ...row, contextCwd: undefined }),
        undefined,
        () => server.contextOwnerId
      )(envelope(other))
    ).toBeNull()
  })

  it('issues distinct capabilities for plain new panes instead of inheriting the caller token', () => {
    const first = { ORCA_AGENT_LAUNCH_TOKEN: 'stale-caller' }
    const second = { ORCA_AGENT_LAUNCH_TOKEN: 'stale-caller' }
    const args = {
      pane: { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1' },
      jcodeRuntimeDir: undefined
    }
    stampPtySpawnPaneEnv(first, args)
    stampPtySpawnPaneEnv(second, args)
    expect(first.ORCA_AGENT_LAUNCH_TOKEN).not.toBe('stale-caller')
    expect(second.ORCA_AGENT_LAUNCH_TOKEN).not.toBe(first.ORCA_AGENT_LAUNCH_TOKEN)
  })
})
