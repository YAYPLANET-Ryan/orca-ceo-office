export type PreservedPortListenOptions = {
  port: number
  retryTimeoutMs?: number
  retryIntervalMs?: number
  tryListen: (port: number) => Promise<void>
}

export type PreservedPortOptions = {
  // Why: persisted or pinned remote-server endpoints must not move during update overlap.
  preservePort?: boolean
  // Why: test-only timing overrides. Production uses the transport defaults.
  preservedPortRetryTimeoutMs?: number
  preservedPortRetryIntervalMs?: number
}

export async function listenOnPreservedPort({
  port,
  retryTimeoutMs,
  retryIntervalMs,
  tryListen
}: PreservedPortListenOptions): Promise<void> {
  const deadline = Date.now() + Math.max(0, retryTimeoutMs ?? 15_000)
  let loggedRetry = false
  for (;;) {
    try {
      await tryListen(port)
      return
    } catch (error: unknown) {
      if (!isAddressInUseError(error)) {
        throw error
      }

      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) {
        throw error
      }

      if (!loggedRetry) {
        console.warn(
          `[ws-transport] Preserved port ${port} is still in use; waiting for the previous ORCA process instead of changing the pairing endpoint`
        )
        loggedRetry = true
      }
      await delay(Math.min(Math.max(1, retryIntervalMs ?? 250), remainingMs))
    }
  }
}

export function isPortListenFallbackError(error: unknown, port: number): boolean {
  if (!(error instanceof Error) || !('code' in error)) {
    return false
  }
  if (error.code === 'EADDRINUSE') {
    return true
  }
  return (
    error.code === 'EACCES' &&
    'syscall' in error &&
    error.syscall === 'listen' &&
    'port' in error &&
    error.port === port
  )
}

function isAddressInUseError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
