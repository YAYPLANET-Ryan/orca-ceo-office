import { TriangleAlert } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { HookContextIntegritySummary } from '../../../../shared/agent-hook-listener/state/hook-context-quarantine-types'

/** Persistent host-scoped warning; it offers no automatic resume or process-control action. */
export function ContextIntegrityNotice({
  summary,
  unavailable
}: {
  summary: HookContextIntegritySummary | null
  unavailable: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const verificationUnavailable = unavailable || !summary || summary.verification === 'unavailable'
  const refused = Boolean(summary && (summary.unverifiedCount > 0 || summary.overflowCount > 0))
  if (!verificationUnavailable && !refused && summary?.durability !== 'unavailable') {
    return null
  }
  return (
    <section
      role="status"
      aria-live="polite"
      data-state={
        refused ? 'refused' : verificationUnavailable ? 'unavailable' : 'storage-unavailable'
      }
      data-durability={summary?.durability ?? 'unavailable'}
      data-current={verificationUnavailable ? 'false' : 'true'}
      className="mx-2 mb-2 shrink-0 rounded-md border border-destructive/50 bg-worktree-sidebar-accent/40 p-2.5 text-worktree-sidebar-foreground"
    >
      <div className="flex items-start gap-2">
        <TriangleAlert className="mt-px size-3.5 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-xs font-semibold leading-snug">
            {t('agent.contextIntegrity.title', 'Conversation ownership needs review')}
          </p>
          <p className="text-xs leading-snug">
            {refused
              ? t(
                  'agent.contextIntegrity.refused',
                  'Some agent events could not be matched to a workspace. Automatic association was blocked. Review the original conversation before resuming.'
                )
              : verificationUnavailable
                ? t(
                    'agent.contextIntegrity.unavailable',
                    'Conversation ownership verification is unavailable on this host. Review the original conversation before resuming.'
                  )
                : t(
                    'agent.contextIntegrity.saveUnavailable',
                    'Conversation diagnostic details could not be saved. Review the original conversation before resuming.'
                  )}
          </p>
          {refused && (verificationUnavailable || summary?.durability !== 'saved') ? (
            <p className="text-xs leading-snug text-muted-foreground">
              {t(
                'agent.contextIntegrity.notSaved',
                'Diagnostic details are not confirmed saved or current.'
              )}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}
