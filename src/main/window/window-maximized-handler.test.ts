import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown) => unknown>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown) => unknown) => {
      if (ipc.handlers.has(channel)) {
        throw new Error('duplicate handler')
      }
      ipc.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => ipc.handlers.delete(channel)
  }
}))
import { registerWindowMaximizedHandler } from './window-maximized-handler'

const disposers: (() => void)[] = []
function windowFor(id: number, maximized: boolean) {
  const frame = {}
  const window = {
    webContents: { id, mainFrame: frame },
    isDestroyed: vi.fn(() => false),
    isMaximized: () => maximized
  }
  return { window, event: { sender: { id }, senderFrame: frame } }
}
function register(window: ReturnType<typeof windowFor>['window']) {
  const dispose = registerWindowMaximizedHandler(window as unknown as BrowserWindow)
  disposers.push(dispose)
  return dispose
}
function invoke(event: unknown) {
  return ipc.handlers.get('window:isMaximized')!(event)
}
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose())
  expect(ipc.handlers.size).toBe(0)
})

describe('window maximized IPC ownership', () => {
  it('routes overlapping windows by sender and survives closing the older window', () => {
    const old = windowFor(1, false)
    const next = windowFor(2, true)
    const closeOld = register(old.window)
    register(next.window)
    expect(invoke(old.event)).toBe(false)
    expect(invoke(next.event)).toBe(true)
    closeOld()
    closeOld()
    expect(invoke(next.event)).toBe(true)
    expect(() => invoke(old.event)).toThrow('Unauthorized')
  })

  it('does not let a stale disposer remove a replacement registration for the same window', () => {
    const window = windowFor(3, true)
    const stale = register(window.window)
    register(window.window)
    stale()
    expect(invoke(window.event)).toBe(true)
  })

  it('rejects unknown senders, subframes and destroyed windows', () => {
    const window = windowFor(4, true)
    register(window.window)
    expect(() => invoke({ sender: { id: 99 }, senderFrame: {} })).toThrow('Unauthorized')
    expect(() => invoke({ ...window.event, senderFrame: {} })).toThrow('Unauthorized')
    window.window.isDestroyed.mockReturnValue(true)
    expect(() => invoke(window.event)).toThrow('Unauthorized')
  })

  it('can reopen after the last window has closed', () => {
    const old = windowFor(5, false)
    register(old.window)()
    const next = windowFor(6, true)
    register(next.window)
    expect(invoke(next.event)).toBe(true)
  })
})
