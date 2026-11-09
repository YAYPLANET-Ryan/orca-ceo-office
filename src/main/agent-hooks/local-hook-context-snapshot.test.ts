import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createLocalHookContextSnapshotReader } from './local-hook-context-snapshot'
import { createLocalPtyInventoryReader } from './local-tmux-managed-pty'
import type { PtyProcessInfo } from '../providers/pty-process-info'
import type { ParsedHookEnvelope } from '../../shared/agent-hook-listener/hook-envelope'
import { PANE } from './server.test-fixtures'

const cwd = resolve('synthetic-workspace-b')
const row: PtyProcessInfo = {
  id: 'pty',
  incarnationId: 'generation',
  launchTokenHash: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  rootProcessId: 123,
  paneBound: true,
  ownerClientInstanceId: 'client-b',
  paneKey: PANE,
  worktreeId: 'wt-1',
  cwd,
  contextCwd: cwd,
  title: 'shell'
}
function envelope(reported = cwd): ParsedHookEnvelope {
  return {
    record: {},
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    hookPayloadRecord: { cwd: reported },
    eventName: 'SessionStart'
  }
}

describe('trusted local hook context snapshot', () => {
  it.each([null, { agentType: 'codex' as const, providerSessionId: 'original-conversation' }])(
    'takes declared intent only from the exact host-owned inventory row',
    async (hookResumeIntent) => {
      const read = createLocalHookContextSnapshotReader(
        async () => ({ ...row, hookResumeIntent }),
        async (path) => path,
        'client-b'
      )
      expect(await read(envelope())).toMatchObject({ resumeIntent: hookResumeIntent })
    }
  )

  it('rejects malformed host intent instead of silently treating it as a fresh launch', async () => {
    const read = createLocalHookContextSnapshotReader(
      async () => ({
        ...row,
        hookResumeIntent: {
          agentType: 'codex',
          providerSessionId: 'original-conversation',
          command: 'synthetic-extra-field'
        }
      }),
      async (path) => path,
      'client-b'
    )
    expect(await read(envelope())).toBeNull()
  })

  it('does not let an unrouted duplicate shadow the established PTY route', async () => {
    const inventory = createLocalPtyInventoryReader({
      getPtyId: () => 'pty',
      listProcesses: async () => [
        { ...row, worktreeId: 'foreign-workspace', routed: false },
        { ...row, routed: true }
      ]
    })
    const read = createLocalHookContextSnapshotReader(inventory, async (path) => path, 'client-b')
    expect(await read(envelope())).toMatchObject({
      worktreeId: 'wt-1',
      incarnationId: 'generation'
    })
  })

  it('requires the current client identity instead of treating missing wiring as ownership', async () => {
    const read = createLocalHookContextSnapshotReader(
      async () => row,
      async (path) => path
    )
    expect(await read(envelope())).toBeNull()
  })

  it('takes a fresh inventory generation even inside the ordinary inventory TTL', async () => {
    let current = row
    const inventory = createLocalPtyInventoryReader({
      getPtyId: () => 'pty',
      listProcesses: async () => [current]
    })
    const read = createLocalHookContextSnapshotReader(inventory, async (path) => path, 'client-b')
    expect(await read(envelope())).toMatchObject({ incarnationId: 'generation', cwd })
    current = { ...row, incarnationId: 'replacement' }
    expect(await read(envelope())).toMatchObject({ incarnationId: 'replacement' })
  })

  it.each([
    'workspace',
    'pane',
    'generation',
    'wsl',
    'exiting',
    'unrouted',
    'unbound',
    'foreign-client'
  ])('refuses incomplete or different ownership: %s', async (kind) => {
    const changed = { ...row }
    if (kind === 'workspace') {
      changed.worktreeId = 'wt-other'
    }
    if (kind === 'pane') {
      changed.paneKey = 'other-pane'
    }
    if (kind === 'generation') {
      delete changed.incarnationId
    }
    if (kind === 'wsl') {
      changed.wslDistro = 'other-host'
    }
    if (kind === 'exiting') {
      changed.exiting = true
    }
    if (kind === 'unrouted') {
      changed.routed = false
    }
    if (kind === 'unbound') {
      changed.paneBound = false
    }
    if (kind === 'foreign-client') {
      changed.ownerClientInstanceId = 'client-other'
    }
    const read = createLocalHookContextSnapshotReader(
      async () => changed,
      async (path) => path,
      'client-b'
    )
    expect(await read(envelope())).toBeNull()
  })

  it('requires an absolute reported CWD and does not widen approval to a shared ancestor', async () => {
    const read = createLocalHookContextSnapshotReader(
      async () => row,
      async (path) => path,
      'client-b'
    )
    expect(await read(envelope('../workspace-a'))).toBeNull()
    expect(await read(envelope(resolve('synthetic-workspace-a')))).toBeNull()
  })

  it('never resolves an untrusted reported path or network share', async () => {
    const canonicalize = vi.fn(async (path: string) => path)
    const read = createLocalHookContextSnapshotReader(async () => row, canonicalize, 'client-b')
    expect(await read(envelope('//foreign-server/share'))).toBeNull()
    expect(canonicalize).not.toHaveBeenCalled()
    expect(await read(envelope(resolve('untrusted-other-workspace')))).toBeNull()
    expect(canonicalize.mock.calls).toEqual([[cwd]])
  })
})
