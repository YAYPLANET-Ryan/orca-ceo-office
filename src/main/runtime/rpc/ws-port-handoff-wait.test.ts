import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { listenAfterPortHandoff } from './ws-port-handoff-wait'
import { WebSocketTransport } from './ws-transport'

function addressInUse(): Error {
  return Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
}

describe('listenAfterPortHandoff', () => {
  it('reclaims the same port once the previous process releases it', async () => {
    const tryListen = vi
      .fn<(port: number) => Promise<void>>()
      .mockRejectedValueOnce(addressInUse())
      .mockRejectedValueOnce(addressInUse())
      .mockResolvedValueOnce(undefined)
    await listenAfterPortHandoff({ port: 6768, waitMs: 1_000, retryIntervalMs: 1, tryListen })
    expect(tryListen.mock.calls.map(([port]) => port)).toEqual([6768, 6768, 6768])
  })

  it('gives the in-use error back after the window so the caller can fall back', async () => {
    let clock = 0
    const tryListen = vi.fn<(port: number) => Promise<void>>().mockImplementation(async () => {
      clock += 600
      throw addressInUse()
    })
    await expect(
      listenAfterPortHandoff({
        port: 6768,
        waitMs: 1_000,
        retryIntervalMs: 1,
        tryListen,
        now: () => clock
      })
    ).rejects.toMatchObject({ code: 'EADDRINUSE' })
    expect(tryListen.mock.calls.length).toBeLessThanOrEqual(3)
  })

  it('does not wait on errors other than an occupied port', async () => {
    const denied = Object.assign(new Error('listen EACCES'), { code: 'EACCES' })
    const tryListen = vi.fn<(port: number) => Promise<void>>().mockRejectedValue(denied)
    await expect(
      listenAfterPortHandoff({ port: 6768, waitMs: 5_000, retryIntervalMs: 1, tryListen })
    ).rejects.toBe(denied)
    expect(tryListen).toHaveBeenCalledTimes(1)
  })
})

describe('WebSocketTransport pairing port handoff', () => {
  const transports: WebSocketTransport[] = []
  const blockers: Server[] = []

  afterEach(async () => {
    await Promise.all(transports.map((transport) => transport.stop().catch(() => {})))
    transports.length = 0
    await Promise.all(
      blockers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    )
    blockers.length = 0
  })

  async function occupyFreePort(): Promise<{ server: Server; port: number }> {
    const server = createServer()
    blockers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address()
    if (!address || typeof address !== 'object') {
      throw new Error('Own blocker listener has no port')
    }
    return { server, port: address.port }
  }

  it('keeps the configured pairing port when the previous holder releases it within the window', async () => {
    const { server, port } = await occupyFreePort()
    setTimeout(() => server.close(), 300)
    const transport = new WebSocketTransport({
      host: '127.0.0.1',
      port,
      fallbackLadder: [],
      portHandoffWaitMs: 5_000
    })
    transports.push(transport)
    await transport.start()
    expect(transport.resolvedPort).toBe(port)
  })

  it('still moves to an OS-assigned port when no handoff wait is configured', async () => {
    const { port } = await occupyFreePort()
    const transport = new WebSocketTransport({ host: '127.0.0.1', port, fallbackLadder: [] })
    transports.push(transport)
    await transport.start()
    expect(transport.resolvedPort).not.toBe(port)
  })
})
