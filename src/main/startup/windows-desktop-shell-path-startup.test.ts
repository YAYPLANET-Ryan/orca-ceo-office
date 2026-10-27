import { describe, expect, it, vi } from 'vitest'
import { startWindowsDesktopBeforeShellPathReady } from './windows-desktop-shell-path-startup'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('Windows desktop shell PATH startup', () => {
  it('opens the first window while shell PATH hydration remains unresolved', async () => {
    const shellPath = deferred()
    const window = { visible: true }
    const openWindow = vi.fn(() => window)
    const startServices = vi.fn(() => ({
      firstWindowReady: Promise.resolve(),
      localPtyReady: Promise.resolve(),
      localPtyProviderReady: Promise.resolve()
    }))

    const startup = startWindowsDesktopBeforeShellPathReady({
      openWindow,
      shellPathReady: shellPath.promise,
      startServices,
      onWindowError: vi.fn()
    })

    expect(startup.window).toBe(window)
    expect(openWindow).toHaveBeenCalledOnce()
    expect(startServices).not.toHaveBeenCalled()

    shellPath.resolve()
    await startup.services
    expect(startServices).toHaveBeenCalledOnce()
  })

  it('keeps service readiness alive after an early window creation failure', async () => {
    const failure = new Error('duplicate handler')
    const onWindowError = vi.fn()
    const services = {
      firstWindowReady: Promise.resolve(),
      localPtyReady: Promise.resolve(),
      localPtyProviderReady: Promise.resolve()
    }
    const startup = startWindowsDesktopBeforeShellPathReady({
      openWindow: () => {
        throw failure
      },
      shellPathReady: Promise.resolve(),
      startServices: () => services,
      onWindowError
    })
    expect(startup.window).toBeNull()
    expect(onWindowError).toHaveBeenCalledWith(failure)
    await expect(startup.services).resolves.toBe(services)
  })
})
