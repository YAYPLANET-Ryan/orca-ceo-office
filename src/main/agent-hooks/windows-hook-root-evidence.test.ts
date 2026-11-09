import { describe, expect, it } from 'vitest'
import { createWindowsHookRootEvidenceReader } from './windows-hook-root-evidence'
import type { WindowsProcessRow } from '../windows/windows-process-table'
import type { HookRootEvidenceRequest } from '../../shared/agent-hook-listener/presence/hook-process-root-evidence'

const epoch = 133000000000000000n
const key = (index: number) => String(epoch + BigInt(index) * 10000n)
const milliseconds = (index: number) =>
  Number((epoch + BigInt(index) * 10000n) / 10000n - 11644473600000n)

function fixture(provider: 'claude' | 'codex' = 'claude') {
  const rows: WindowsProcessRow[] = [
    {
      pid: 100,
      ppid: 1,
      name: 'powershell.exe',
      command: 'powershell.exe',
      creationTimeMs: milliseconds(0)
    },
    {
      pid: 200,
      ppid: 100,
      name: `${provider}.exe`,
      command: `C:\\apps\\${provider}.exe --no-daemon`,
      creationTimeMs: milliseconds(1)
    },
    {
      pid: 300,
      ppid: 200,
      name: 'orca-agent-hook.exe',
      command: `orca-agent-hook.exe ${provider}`,
      creationTimeMs: milliseconds(2)
    }
  ]
  const keys = new Map([
    [100, key(0)],
    [200, key(1)],
    [300, key(2)]
  ])
  const request: HookRootEvidenceRequest = {
    paneKey: 'pane',
    worktreeId: 'workspace',
    agent: provider,
    process: { pid: 999, platform: 'win32', startTime: 'untrusted-body-claim' },
    peer: { pid: 300, creationTimeKey: key(2), isCurrent: () => true }
  }
  const read = createWindowsHookRootEvidenceReader(
    async () => ({ pid: 100, incarnation: 'current-generation', creationTimeKey: key(0) }),
    async () => rows,
    (pid) => keys.get(pid) ?? null
  )
  return { rows, keys, request, read }
}

describe('Windows OS-bound hook caller evidence', () => {
  it.each(['claude', 'codex'] as const)(
    'proves the actual %s caller ancestry instead of a nominated body PID',
    async (provider) => {
      const { read, request } = fixture(provider)
      expect(await read(request)).toEqual({
        verdict: 'root',
        binding: 'current-generation',
        process: { pid: 200, platform: 'win32', startTime: `win32:${milliseconds(1)}` }
      })
    }
  )

  it('refuses a body-only PID even when it names a live-looking provider', async () => {
    const { read, request } = fixture()
    expect(await read({ ...request, peer: undefined })).toEqual({ verdict: 'unknown' })
  })

  it('refuses PID reuse inside the same millisecond using full FILETIME keys', async () => {
    const { read, request, keys } = fixture()
    keys.set(300, String(BigInt(key(2)) + 1n))
    expect(await read(request)).toEqual({ verdict: 'unknown' })
  })

  it('refuses a reused PTY root even when the current table and native key agree', async () => {
    const { read, request, rows, keys } = fixture()
    keys.set(100, String(BigInt(key(0)) + 1n))
    rows[0].creationTimeMs = milliseconds(0)
    expect(await read(request)).toEqual({ verdict: 'unknown' })
  })

  it('refuses a nested job of the same provider', async () => {
    const { read, request, rows, keys } = fixture('codex')
    rows.push({
      pid: 150,
      ppid: 100,
      name: 'codex.exe',
      command: 'codex.exe --no-daemon',
      creationTimeMs: milliseconds(0)
    })
    rows.push({
      pid: 175,
      ppid: 150,
      name: 'cmd.exe',
      command: 'cmd.exe',
      creationTimeMs: milliseconds(0)
    })
    rows[1].ppid = 175
    keys.set(150, key(0))
    keys.set(175, key(0))
    expect(await read(request)).toEqual({ verdict: 'nested' })
  })

  it('permits an adjacent Node CLI shim above its native provider', async () => {
    const { read, request, rows, keys } = fixture('codex')
    rows.push({
      pid: 150,
      ppid: 100,
      name: 'node.exe',
      command: 'node.exe C:\\apps\\codex.js --no-daemon',
      creationTimeMs: milliseconds(0)
    })
    rows[1].ppid = 150
    keys.set(150, key(0))
    expect((await read(request))?.verdict).toBe('root')
  })

  it('refuses a parent PID that was born after its claimed child', async () => {
    const { read, request, rows, keys } = fixture()
    keys.set(200, key(3))
    rows[1].creationTimeMs = milliseconds(3)
    expect(await read(request)).toEqual({ verdict: 'unknown' })
  })

  it('refuses hooks beneath a different provider', async () => {
    const { read, request, rows } = fixture()
    rows[1].command = 'C:\\apps\\codex.exe --no-daemon'
    expect(await read(request)).toEqual({ verdict: 'nested' })
  })

  it('recognizes a provider directly owning the PTY root', async () => {
    const { read, request, rows } = fixture('codex')
    rows[0].command = 'codex.exe --no-daemon'
    rows[1].command = 'cmd.exe'
    expect(await read(request)).toEqual({
      verdict: 'root',
      binding: 'current-generation',
      process: { pid: 100, platform: 'win32', startTime: `win32:${milliseconds(0)}` }
    })
  })

  it('does not adopt a shared Codex backend as an interactive pane owner', async () => {
    const { read, request, rows } = fixture('codex')
    rows[1].command = 'C:\\apps\\codex.exe app-server daemon run'
    expect((await read(request))?.verdict).not.toBe('root')
  })

  it.each(['exec -', 'review', '--no-daemon resume original', '--no-daemon fork original'])(
    'preserves an owned local Codex lifecycle: %s',
    async (mode) => {
      const { read, request, rows } = fixture('codex')
      rows[1].command = `C:\\apps\\codex.exe ${mode}`
      expect((await read(request))?.verdict).toBe('root')
    }
  )

  it.each([
    '--remote tcp://other resume original',
    'agents',
    'queue',
    'login',
    '--unknown-runtime-flag'
  ])('does not treat remote, shared or unknown Codex modes as this pane: %s', async (mode) => {
    const { read, request, rows } = fixture('codex')
    rows[1].command = `C:\\apps\\codex.exe ${mode}`
    expect((await read(request))?.verdict).not.toBe('root')
  })

  it.each([
    'codex.exe app-server daemon run',
    'node.exe C:\\apps\\node_modules\\@openai\\codex\\bin\\codex.js app-server daemon run'
  ])('does not borrow a still-live frontend above a shared backend: %s', async (command) => {
    const { read, request, rows, keys } = fixture('codex')
    rows.push({ pid: 250, ppid: 200, name: 'codex.exe', command, creationTimeMs: milliseconds(2) })
    rows[2].ppid = 250
    rows[2].creationTimeMs = milliseconds(3)
    keys.set(250, key(2))
    keys.set(300, key(3))
    expect(
      (
        await read({
          ...request,
          peer: { pid: 300, creationTimeKey: key(3), isCurrent: () => true }
        })
      )?.verdict
    ).not.toBe('root')
  })

  it('refuses a caller that disappears during proof', async () => {
    const { read, request } = fixture()
    let checks = 0
    const peer = { pid: 300, creationTimeKey: key(2), isCurrent: () => ++checks === 1 }
    expect(await read({ ...request, peer })).toEqual({ verdict: 'unknown' })
  })

  it('refuses replacement of the PTY generation during the native read', async () => {
    const { request, rows, keys } = fixture()
    let reads = 0
    const read = createWindowsHookRootEvidenceReader(
      async () => ({
        pid: 100,
        incarnation: ++reads === 1 ? 'before' : 'after',
        creationTimeKey: key(0)
      }),
      async () => rows,
      (pid) => keys.get(pid) ?? null
    )
    expect(await read(request)).toEqual({ verdict: 'unknown' })
    expect(reads).toBe(2)
  })
})
