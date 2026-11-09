import { once } from 'node:events'
import { createServer, type Socket } from 'node:net'
import { spawnProcess } from '@orca/process-host'
import { expect, it } from 'vitest'
import { readWindowsLoopbackTcpPeer, readWindowsProcessCreationKey } from './windows-hook-peer'

it.runIf(process.platform === 'win32')(
  'identifies the actual loopback client process through the compiled addon',
  async () => {
    let accepted: Socket | undefined
    let receive!: (value: ReturnType<typeof readWindowsLoopbackTcpPeer>) => void
    const received = new Promise<ReturnType<typeof readWindowsLoopbackTcpPeer>>((resolve) => {
      receive = resolve
    })
    const server = createServer((socket) => {
      accepted = socket
      receive(readWindowsLoopbackTcpPeer(socket.localPort ?? 0, socket.remotePort ?? 0))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Owned TCP fixture did not bind')
    }
    const child = spawnProcess({
      program: process.execPath,
      args: [
        '-e',
        "const net=require('node:net');const c=net.connect(Number(process.argv[1]),'127.0.0.1');c.on('error',()=>process.exit(1));c.on('close',()=>process.exit(0));",
        String(address.port)
      ]
    })
    const closed = once(child, 'close', { signal: AbortSignal.timeout(5000) })
    child.stdout.resume()
    child.stderr.resume()
    try {
      const peer = await Promise.race([
        received,
        closed.then(() => {
          throw new Error('Owned client exited before peer observation')
        })
      ])
      expect(peer?.pid).toBe(child.pid)
      expect(peer?.pid).not.toBe(process.pid)
      expect(peer?.creationTimeKey).toMatch(/^\d{15,20}$/)
      expect(readWindowsProcessCreationKey(child.pid ?? 0)).toBe(peer?.creationTimeKey)
    } finally {
      accepted?.destroy()
      server.close()
      try {
        await closed
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL')
        }
      }
    }
  }
)
