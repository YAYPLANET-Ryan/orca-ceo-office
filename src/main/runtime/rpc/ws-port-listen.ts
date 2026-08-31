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

export class PreservedPairingPortDeniedError extends Error {
  readonly code = 'ORCA_PAIRING_PORT_DENIED'
  readonly port: number

  constructor(port: number, cause: unknown) {
    super(
      `The operating system denied ORCA access to preserved pairing port ${port}. On Windows, confirm that the port is not in an excluded TCP range; ORCA will not silently change an existing pairing endpoint.`,
      { cause }
    )
    this.name = 'PreservedPairingPortDeniedError'
    this.port = port
  }
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
      if (isAccessDeniedListenError(error, port)) {
        throw new PreservedPairingPortDeniedError(port, error)
      }
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

function isAccessDeniedListenError(error: unknown, port: number): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'EACCES' &&
    'syscall' in error &&
    error.syscall === 'listen' &&
    'port' in error &&
    error.port === port
  )
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}
