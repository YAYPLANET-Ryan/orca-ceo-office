import { ContextIntegrityNotice } from './ContextIntegrityNotice'
import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useWorktreeRuntimeTarget } from '@/runtime/rpc/targets/use-worktree-runtime-target'
import {
  readHookContextIntegritySummary,
  type HookContextIntegritySummary
} from '../../../../shared/agent-hook-listener/state/hook-context-quarantine-types'

/** Show the owning host's refusal state, never a local-machine substitute for an unknown host. */
export function ContextIntegrityBanner(): React.JSX.Element | null {
  const worktreeId = useAppStore((state) => state.activeWorktreeId)
  const target = useWorktreeRuntimeTarget(worktreeId)
  const key = target?.kind === 'environment' ? target.environmentId : (target?.kind ?? null)
  const [state, setState] = useState<{
    key: string | null
    summary: HookContextIntegritySummary | null
    unavailable: boolean
  } | null>(null)

  useEffect(() => {
    if (!worktreeId) {
      return
    }
    if (!target) {
      return
    }
    let disposed = false
    let inFlight = false
    const refresh = async (): Promise<void> => {
      if (disposed || inFlight || document.visibilityState === 'hidden') {
        return
      }
      inFlight = true
      try {
        const response = await callRuntimeRpc<unknown>(
          target,
          'diagnostics.contextIntegrity',
          undefined,
          {
            timeoutMs: 5000,
            reuseRecentCompatibilityFailure: true,
            suppressFeatureInteraction: true
          }
        )
        const summary = readHookContextIntegritySummary(response)
        if (!summary) {
          throw new Error('Context integrity health unavailable')
        }
        if (!disposed) {
          setState({ key, summary, unavailable: false })
        }
      } catch {
        if (!disposed) {
          setState((previous) => ({
            key,
            summary: previous?.key === key ? previous.summary : null,
            unavailable: true
          }))
        }
      } finally {
        inFlight = false
      }
    }
    const onVisible = (): void => {
      void refresh()
    }
    void refresh()
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    const timer = window.setInterval(onVisible, 30_000)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [key, target, worktreeId])

  if (!worktreeId) {
    return null
  }
  const current = target && state?.key === key ? state : null
  const summary = current?.summary
  const unavailable = !current || current.unavailable
  return <ContextIntegrityNotice summary={summary ?? null} unavailable={unavailable} />
}
