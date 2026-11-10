// Why: during an update or relaunch the previous ORCA process can still hold the pairing port for a few
// seconds. Moving to the next rung at once strands every paired laptop, so the first configured port
// is retried while it is merely in use, and the caller's normal fallback runs only after the window.
export const PAIRING_PORT_HANDOFF_WAIT_MS = 15_000
const RETRY_INTERVAL_MS = 250

function isAddressInUse(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EADDRINUSE'
}

export async function listenAfterPortHandoff({
  port,
  waitMs,
  tryListen,
  retryIntervalMs = RETRY_INTERVAL_MS,
  now = Date.now
}: {
  port: number
  waitMs: number
  tryListen: (port: number) => Promise<void>
  retryIntervalMs?: number
  now?: () => number
}): Promise<void> {
  const deadline = now() + Math.max(0, waitMs)
  let warned = false
  for (;;) {
    try {
      await tryListen(port)
      return
    } catch (error: unknown) {
      const remainingMs = deadline - now()
      if (!isAddressInUse(error) || remainingMs <= 0) {
        throw error
      }
      if (!warned) {
        console.warn(
          `[ws-transport] Port ${port} is still in use; waiting for the previous ORCA process before changing the pairing endpoint`
        )
        warned = true
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryIntervalMs, remainingMs)))
    }
  }
}
