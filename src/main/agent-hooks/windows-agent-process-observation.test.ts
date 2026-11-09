import { describe, expect, it } from 'vitest'
import { createWindowsAgentProcessObservationReader } from './windows-agent-process-observation'

const key = '133000000000000000'

describe('Windows native agent liveness', () => {
  it('compares the same Unix-millisecond identity format as admitted hooks', async () => {
    const read = createWindowsAgentProcessObservationReader(
      () => key,
      async () => [],
      42
    )
    expect(await read(100)).toEqual({
      verdict: 'live',
      startTime: 'win32:1655526400000',
      zombie: false
    })
  })

  it('reports exit only when native metadata works and a complete table omits the owner', async () => {
    const read = createWindowsAgentProcessObservationReader(
      (pid) => (pid === 42 ? key : null),
      async () => [{ pid: 42, ppid: 1, name: 'node.exe' }],
      42
    )
    expect(await read(100)).toEqual({ verdict: 'exited' })
  })

  it('does not turn unsupported native capabilities or denied metadata into an exit', async () => {
    const missing = createWindowsAgentProcessObservationReader(
      () => null,
      async () => [{ pid: 42, ppid: 1, name: 'node.exe' }],
      42
    )
    expect(await missing(100)).toEqual({ verdict: 'unverifiable' })
    const denied = createWindowsAgentProcessObservationReader(
      (pid) => (pid === 42 ? key : null),
      async () => [
        { pid: 42, ppid: 1, name: 'node.exe' },
        { pid: 100, ppid: 42, name: 'claude.exe' }
      ],
      42
    )
    expect(await denied(100)).toEqual({ verdict: 'unverifiable' })
  })
})
