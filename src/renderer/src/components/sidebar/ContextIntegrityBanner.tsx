import { ContextIntegrityNotice } from './ContextIntegrityNotice'
import { useEffect, useState } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'
import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { useWorktreeRuntimeTarget } from '@/runtime/rpc/targets/use-worktree-runtime-target'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  readHookContextIntegritySummary,
  type HookContextIntegritySummary
} from '../../../../shared/agent-hook-listener/state/hook-context-quarantine-types'

async function readOwningHostContextIntegrity(
  target: RuntimeClientTarget
): Promise<HookContextIntegritySummary | null> {
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
    return readHookContextIntegritySummary(response)
  } catch {
    return null
  }
}

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
      const summary = await readOwningHostContextIntegrity(target)
      inFlight = false
      if (disposed) {
        return
      }
      if (summary) {
        setState({ key, summary, unavailable: false })
      } else {
        setState((previous) => ({
          key,
          summary: previous?.key === key ? previous.summary : null,
          unavailable: true
        }))
      }
    }
    const onVisible = (): void => {
      void refresh()
    }
    const stopInterval = installWindowVisibilityInterval({ run: onVisible, intervalMs: 30_000 })
    window.addEventListener('focus', onVisible)
    return () => {
      disposed = true
      stopInterval()
      window.removeEventListener('focus', onVisible)
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
