import { describe, expect, it, vi } from 'vitest'
import { startDesktopWindowAndRpc } from './desktop-window-rpc-startup'
import { createServeDesktopActivationGate } from './serve-desktop-activation'
import { focusExistingMainWindow } from '../window/focus-existing-window'
import type { BrowserWindow } from 'electron'

describe('desktop window and RPC startup', () => {
  it('retries and reveals a fresh window for queued activation after startup window failure', async () => {
    const failure = new Error('window creation failed')
    const window = {
      isDestroyed: () => false,
      isMinimized: () => false,
      show: vi.fn(),
      focus: vi.fn()
    } as unknown as BrowserWindow
    let current: BrowserWindow | null = null
    const openWindow = vi
      .fn<() => BrowserWindow>()
      .mockImplementationOnce(() => {
        throw failure
      })
      .mockImplementation(() => {
        current = window
        return window
      })
    const gate = createServeDesktopActivationGate({
      initialState: 'initializing',
      activateWindow: () => {
        focusExistingMainWindow({
          app: { isReady: () => true, focus: vi.fn() },
          getWindow: () => current,
          openWindow,
          platform: 'linux',
          setTimeout: () => undefined
        })
      }
    })
    gate.requestActivation()
    expect(current).toBeNull()
    await expect(
      startDesktopWindowAndRpc({ openWindow, startRpc: async () => {} }).finally(() =>
        gate.markReady()
      )
    ).rejects.toBe(failure)
    expect(openWindow).toHaveBeenCalledTimes(2)
    expect(current).toBe(window)
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

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
