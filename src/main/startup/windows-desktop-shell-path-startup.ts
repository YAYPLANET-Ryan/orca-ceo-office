export type WindowsDesktopStartupServices = {
  firstWindowReady: Promise<void>
  localPtyReady: Promise<void>
  localPtyProviderReady: Promise<void>
}

type WindowsDesktopShellPathStartupOptions<TWindow> = {
  openWindow: () => TWindow
  shellPathReady: Promise<void>
  startServices: () => WindowsDesktopStartupServices
  onWindowError: (error: unknown) => void
}

export function startWindowsDesktopBeforeShellPathReady<TWindow>(
  options: WindowsDesktopShellPathStartupOptions<TWindow>
): { window: TWindow | null; services: Promise<WindowsDesktopStartupServices> } {
  const services = options.shellPathReady.then(options.startServices)
  try {
    return { window: options.openWindow(), services }
  } catch (error) {
    // Why: retry with RPC startup after PATH hydration instead of aborting the entire runtime.
    options.onWindowError(error)
    return { window: null, services }
  }
}
