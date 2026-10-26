import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonClientConnections } from './daemon-client-connections'
import { getDaemonSocketPath } from './daemon-spawner'
import { PROTOCOL_VERSION } from './types'

describe('daemon rejection replies reach named-pipe clients before close', () => {
  let dir: string
  let socketPath: string
  let server: Server
  let connections: DaemonClientConnections
  let accepting: boolean
  const log = vi.fn()
  const onControlRequest = vi.fn()

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'orca-hello-reject-'))
    socketPath = getDaemonSocketPath(dir)
    accepting = true
    log.mockClear()
    onControlRequest.mockClear()
    connections = new DaemonClientConnections({
      token: 'synthetic',
      protocolVersion: PROTOCOL_VERSION,
      identity: {
        launchNonce: 'synthetic',
        startedAtMs: 1,
        entryPath: null,
        appVersion: null,
        spawnerExecPath: null
      },
      log: { log } as never,
      streamDataBatcher: { flush: vi.fn() } as never,
      isAcceptingWork: () => accepting,
      onTransportChanged: vi.fn(),
      onConnectionAccepted: vi.fn(),
      onAuthenticatedPair: vi.fn(),
      onLastAuthenticatedClientDisconnected: vi.fn(),
      onControlRequest,
      onControlReplaced: vi.fn(),
      onClientDisconnected: vi.fn(),
      onStreamDisconnected: vi.fn()
    })
    server = createServer((socket) => connections.accept(socket))
    await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  })

  afterEach(async () => {
    connections.dispose()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  })

  async function rejectedReply(payload: string): Promise<Record<string, unknown>> {
    let socket: Socket
    return new Promise((resolve, reject) => {
      let data = ''
      socket = createConnection(socketPath, () => socket.write(payload))
      socket.on('error', reject)
      socket.on('data', (chunk) => {
        data += chunk.toString()
      })
      socket.on('close', () => {
        try {
          resolve(JSON.parse(data.trim()))
        } catch (error) {
          reject(error)
        }
      })
    })
  }

  const hello = {
    type: 'hello',
    version: PROTOCOL_VERSION,
    token: 'synthetic',
    clientId: 'synthetic-client',
    role: 'control'
  }
  it.each([
    ['expected-hello', 'null\n', 'Expected hello'],
    [
      'protocol-mismatch',
      `${JSON.stringify({ ...hello, version: -1 })}\n`,
      'Protocol version mismatch'
    ],
    ['invalid-token', `${JSON.stringify({ ...hello, token: 'wrong' })}\n`, 'Invalid token'],
    ['invalid-role', `${JSON.stringify({ ...hello, role: 'other' })}\n`, 'Invalid role'],
    [
      'missing-control',
      `${JSON.stringify({ ...hello, role: 'stream' })}\n`,
      'Control connection required'
    ],
    ['malformed-frame', '{broken\n', 'Invalid hello frame'],
    ['malformed-frame', `{broken\n${JSON.stringify(hello)}\n`, 'Invalid hello frame'],
    ['expected-hello', `null\n${JSON.stringify(hello)}\n`, 'Expected hello']
  ])('flushes %s without creating a client', async (reason, payload, error) => {
    expect(await rejectedReply(payload)).toMatchObject({ type: 'hello', ok: false, error })
    expect(connections.size).toBe(0)
    expect(log).toHaveBeenCalledWith('client-hello-rejected', expect.objectContaining({ reason }))
  })

  it('delivers an accepted control request after the hello parser is detached', async () => {
    const socket = createConnection(socketPath)
    try {
      await new Promise<void>((resolve) => socket.once('connect', resolve))
      const response = new Promise<Buffer>((resolve) => socket.once('data', resolve))
      socket.write(`${JSON.stringify(hello)}\n`)
      expect(JSON.parse((await response).toString()).ok).toBe(true)
      const request = { id: 'synthetic-request', type: 'listSessions' }
      socket.write(`${JSON.stringify(request)}\n`)
      await vi.waitFor(() =>
        expect(onControlRequest).toHaveBeenCalledWith(expect.anything(), hello.clientId, request)
      )
    } finally {
      socket.destroy()
    }
  })

  it('flushes temporary unavailability', async () => {
    accepting = false
    expect(await rejectedReply(`${JSON.stringify(hello)}\n`)).toMatchObject({
      ok: false,
      retryable: true
    })
    expect(connections.size).toBe(0)
  })
})
