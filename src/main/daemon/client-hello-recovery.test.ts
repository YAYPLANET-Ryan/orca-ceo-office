import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonProtocolError } from './types'
import { getDaemonSocketPath } from './daemon-spawner'
import { DaemonHelloClosedError } from './daemon-hello-closed-error'
import { isDaemonGoneError } from './daemon-endpoint-errors'
import { encodeNdjson } from './ndjson'
import type { HelloMessage } from './types'

describe('hello EOF recovery preserves the daemon', () => {
  let dir: string
  let tokenPath: string
  let socketPath: string
  let server: Server
  let client: DaemonClient
  let sockets: Set<Socket>
  let hellos: HelloMessage[]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orca-hello-recovery-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'synthetic.token')
    writeFileSync(tokenPath, 'synthetic-one')
    client = new DaemonClient({ socketPath, tokenPath })
    sockets = new Set()
    hellos = []
  })

  afterEach(async () => {
    client.disconnect()
    for (const socket of sockets) {
      socket.destroy()
    }
    if (server?.listening) {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    rmSync(dir, { recursive: true, force: true })
  })

  async function listen(onHello: (socket: Socket, hello: HelloMessage) => void): Promise<void> {
    server = createServer((socket) => {
      sockets.add(socket)
      socket.on('error', () => {})
      socket.once('close', () => sockets.delete(socket))
      let data = ''
      socket.on('data', (chunk) => {
        data += chunk.toString()
        const end = data.indexOf('\n')
        if (end === -1) {
          return
        }
        const hello = JSON.parse(data.slice(0, end)) as HelloMessage
        data = data.slice(end + 1)
        hellos.push(hello)
        onHello(socket, hello)
      })
    })
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  }

  function accept(socket: Socket): void {
    socket.write(
      encodeNdjson({
        type: 'hello',
        ok: true,
        daemonIdentity: { pid: 123, startedAtMs: 456, launchNonce: 'synthetic-generation' }
      })
    )
  }

  it('reconnects once and re-reads credentials after a control hello closes', async () => {
    await listen((socket) => {
      if (hellos.length === 1) {
        writeFileSync(tokenPath, 'synthetic-two')
        socket.end()
      } else {
        accept(socket)
      }
    })
    await Promise.all([
      client.ensureConnected(),
      client.ensureConnected(),
      client.ensureConnected()
    ])
    expect(client.isConnected()).toBe(true)
    expect(hellos.map((h) => h.role)).toEqual(['control', 'control', 'stream'])
    expect(hellos.map((h) => h.token)).toEqual(['synthetic-one', 'synthetic-two', 'synthetic-two'])
    expect(new Set(hellos.map((h) => h.clientId)).size).toBe(1)
  })

  it('rebuilds the whole pair after a stream hello closes', async () => {
    await listen((socket) => (hellos.length === 2 ? socket.end() : accept(socket)))
    await client.ensureConnected()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(client.isConnected()).toBe(true)
    expect(hellos.map((h) => h.role)).toEqual(['control', 'stream', 'control', 'stream'])
    expect(client.getDaemonIdentity()?.launchNonce).toBe('synthetic-generation')
  })

  it('stops after three hello EOFs without classifying the daemon as dead', async () => {
    await listen((socket) => socket.end())
    const failure = await client.ensureConnected().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DaemonHelloClosedError)
    expect(failure).toBeInstanceOf(DaemonProtocolError)
    expect(isDaemonGoneError(failure)).toBe(false)
    expect(hellos).toHaveLength(3)
    expect(client.isConnected()).toBe(false)
  })

  it('does not invoke the adapter respawn callback after exhausted hello EOFs', async () => {
    await listen((socket) => socket.end())
    const respawn = vi.fn()
    const adapter = new DaemonPtyAdapter({ socketPath, tokenPath, respawn })
    try {
      await expect(adapter.spawn({ cols: 80, rows: 24 })).rejects.toThrow(
        'Connection closed before hello response'
      )
      expect(respawn).not.toHaveBeenCalled()
      expect(hellos).toHaveLength(3)
    } finally {
      adapter.dispose()
    }
  })

  it('does not retry a flushed explicit rejection', async () => {
    await listen((socket) =>
      socket.end(encodeNdjson({ type: 'hello', ok: false, error: 'Invalid token' }))
    )
    await expect(client.ensureConnected()).rejects.toThrow('Invalid token')
    expect(hellos).toHaveLength(1)
  })

  it('does not restart an explicitly disconnected generation during retry backoff', async () => {
    await listen((socket) => {
      socket.end()
      setTimeout(() => client.disconnect(), 10)
    })
    await expect(client.ensureConnected()).rejects.toThrow('Disconnected')
    expect(hellos).toHaveLength(1)
    expect(client.isConnected()).toBe(false)
  })

  it('does not spend a bounded teardown budget on reconnect backoff', async () => {
    await listen((socket) => socket.end())
    await expect(client.ensureConnectedWithin(40)).rejects.toThrow(
      /Hello response timed out|Connection closed before hello response/
    )
    expect(hellos.length).toBeLessThanOrEqual(1)
  })
})
