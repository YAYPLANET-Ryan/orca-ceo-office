import type { AgentHookServer } from './server'
import { settleWithinMs } from '../startup/quit/quit-teardown-deadline'

type QuitObservationServer = Pick<
  AgentHookServer,
  'stop' | 'hasPendingProviderObservations' | 'flushProviderObservations'
>

export function stopProviderObservationIngressForQuit(
  server: QuitObservationServer,
  options?: Parameters<AgentHookServer['stop']>[0]
): { drain: Promise<boolean> | null; errors: unknown[] } {
  const errors: unknown[] = []
  try {
    server.stop(options)
  } catch (error) {
    errors.push(error)
  }
  let drain: Promise<boolean> | null = null
  try {
    drain = beginProviderObservationQuitDrain(server)
  } catch (error) {
    errors.push(error)
  }
  if (errors.length > 0) {
    console.warn('[agent-hooks] Hook ingress stop incomplete at quit', {
      errorCount: errors.length
    })
  }
  return { drain, errors }
}

/** Call after stopping ingress and before detaching the owned daemon client. */
export function beginProviderObservationQuitDrain(
  server: Pick<AgentHookServer, 'hasPendingProviderObservations' | 'flushProviderObservations'>
): Promise<boolean> | null {
  if (!server.hasPendingProviderObservations) {
    return null
  }
  let flush: Promise<boolean>
  try {
    flush = server.flushProviderObservations()
  } catch (error) {
    flush = Promise.reject(error)
  }
  return settleWithinMs(flush, 1000).then((result) => {
    const acknowledged = result.outcome === 'settled' && result.value
    if (!acknowledged) {
      console.warn('[agent-hooks] Provider observation acknowledgement incomplete at quit', {
        outcome: result.outcome
      })
    }
    return acknowledged
  })
}

export function createProviderObservationQuitStop(
  server: QuitObservationServer
): () => Promise<void> {
  let stopping: Promise<void> | undefined
  return () => {
    stopping ??= Promise.resolve().then(async () => {
      const stopped = stopProviderObservationIngressForQuit(server)
      await stopped.drain
      throwQuitFailures(stopped.errors)
    })
    return stopping
  }
}

/** Attempt the final save even if stopping failed, retaining both failures for the lifetime gate. */
export async function saveAfterProviderObservationQuitStop(
  stop: () => Promise<void>,
  save: () => Promise<void>
): Promise<void> {
  const stopped = await Promise.allSettled([Promise.resolve().then(stop)])
  const saved = await Promise.allSettled([Promise.resolve().then(save)])
  const failures: unknown[] = []
  for (const result of [...stopped, ...saved]) {
    if (result.status === 'rejected') {
      failures.push(result.reason)
    }
  }
  throwQuitFailures(failures)
}

function throwQuitFailures(failures: readonly unknown[]): void {
  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'hook_observation_stop_and_final_save_failed')
  }
}
