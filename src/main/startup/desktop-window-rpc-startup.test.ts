import { describe, expect, it, vi } from 'vitest'
import { startDesktopWindowAndRpc } from './desktop-window-rpc-startup'

describe('desktop window and RPC startup', () => {
  it('still starts RPC when creating the window throws synchronously', async () => {
    const failure = new Error('window handler already registered')
    const startRpc = vi.fn(async () => {})
    await expect(
      startDesktopWindowAndRpc({
        openWindow: () => {
          throw failure
        },
        startRpc
      })
    ).rejects.toBe(failure)
    expect(startRpc).toHaveBeenCalledOnce()
  })

  it('waits for RPC readiness before reporting a window failure', async () => {
    let resolve!: () => void
    const rpc = new Promise<void>((done) => {
      resolve = done
    })
    const failure = new Error('window failed')
    const finished = vi.fn()
    const startup = startDesktopWindowAndRpc({
      openWindow: () => {
        throw failure
      },
      startRpc: () => rpc
    }).catch(finished)
    await Promise.resolve()
    expect(finished).not.toHaveBeenCalled()
    resolve()
    await startup
    expect(finished).toHaveBeenCalledWith(failure)
  })

  it('returns a usable window and an explicit RPC failure', async () => {
    const window = {}
    const error = new Error('EADDRINUSE')
    expect(
      await startDesktopWindowAndRpc({
        openWindow: () => window,
        startRpc: async () => {
          throw error
        }
      })
    ).toEqual({ window, rpc: { ok: false, error } })
  })

  it('observes both failures without leaving an unhandled RPC rejection', async () => {
    const failure = new Error('window failed')
    const rpcFailure = new Error('RPC failed')
    const onRpcError = vi.fn()
    await expect(
      startDesktopWindowAndRpc({
        openWindow: () => {
          throw failure
        },
        startRpc: async () => {
          throw rpcFailure
        },
        onRpcError
      })
    ).rejects.toBe(failure)
    expect(onRpcError).toHaveBeenCalledWith(rpcFailure)
  })
})
