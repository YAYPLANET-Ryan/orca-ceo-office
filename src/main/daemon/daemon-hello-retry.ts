import { readFileSync } from 'node:fs'
import { DaemonHelloClosedError } from './daemon-hello-closed-error'

export async function connectWithHelloRetry(options: {
  timeoutMs: number
  sharedBudget: boolean
  assertCurrent: () => void
  connect: (timeoutMs: number, sharedBudget: boolean) => Promise<void>
}): Promise<void> {
  const { timeoutMs, sharedBudget, assertCurrent, connect } = options
  const deadline = Date.now() + timeoutMs * (sharedBudget ? 1 : 4)
  for (let attempt = 0; ; attempt++) {
    assertCurrent()
    try {
      await connect(
        attempt === 0 ? timeoutMs : Math.max(1, deadline - Date.now()),
        attempt === 0 ? sharedBudget : true
      )
      return
    } catch (error) {
      assertCurrent()
      if (
        !(error instanceof DaemonHelloClosedError) ||
        attempt >= 2 ||
        Date.now() + 50 >= deadline
      ) {
        throw error
      }
      // Re-read credentials on retry; hello EOF never authorizes killing the daemon.
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      assertCurrent()
      if (Date.now() >= deadline) {
        throw error
      }
    }
  }
}

// A missing token must not preempt the connect that proves whether the endpoint is gone.
export function readDaemonToken(tokenPath: string): string {
  try {
    return readFileSync(tokenPath, 'utf-8').trim()
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      return ''
    }
    throw error
  }
}
