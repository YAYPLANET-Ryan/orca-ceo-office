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
      // A hello EOF does not establish daemon death; rebuild sockets, never the process.
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
      assertCurrent()
      if (Date.now() >= deadline) {
        throw error
      }
    }
  }
}
