import { useState } from 'react'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  recoverPaneConversation,
  type ConversationRecoveryResult
} from '@/lib/pane-conversation-recovery'

export function PaneConversationRecovery({
  paneKey
}: {
  paneKey: string
}): React.JSX.Element | null {
  const record = useAppStore((s) => s.sleepingAgentSessionsByPaneKey[paneKey])
  const foreground = useAppStore((s) => s.paneForegroundAgentByPaneKey[paneKey])
  const [pending, setPending] = useState(false)
  const [attempt, setAttempt] = useState<{
    record: SleepingAgentSessionRecord
    foreground: PaneForegroundAgentEntry
    result: ConversationRecoveryResult
  } | null>(null)
  const result =
    attempt?.record === record && attempt?.foreground === foreground ? attempt?.result : null
  const redirected = Boolean(record?.resumeTargetPaneKey && record.resumeTargetPaneKey !== paneKey)
  if (
    !record?.requiresManualResume ||
    !foreground?.shellForeground ||
    record.automaticResumeBlockedBy
  ) {
    return null
  }
  const recover = async (): Promise<void> => {
    setPending(true)
    try {
      setAttempt({ record, foreground, result: await recoverPaneConversation(paneKey) })
    } finally {
      setPending(false)
    }
  }
  const message =
    result === 'uncertain'
      ? translate(
          'sessionRecovery.uncertain',
          'Delivery could not be confirmed. Check the terminal before retrying.'
        )
      : result === 'submitted' || result === 'busy'
        ? translate('sessionRecovery.submitted', 'Resume requested; waiting for the agent.')
        : result === 'changed'
          ? translate(
              'sessionRecovery.changed',
              'Terminal input changed. Finish or cancel the command before resuming.'
            )
          : result === 'unavailable'
            ? translate(
                'sessionRecovery.unavailable',
                'Cannot safely resume here yet. Your saved conversation is retained.'
              )
            : record.resumeTargetPaneKey
              ? redirected
                ? translate(
                    'sessionRecovery.pending',
                    'Recovery is not confirmed. Your conversation is saved; continue in its recovery tab.'
                  )
                : translate(
                    'sessionRecovery.pendingHere',
                    'Recovery is not confirmed. Your conversation is saved; you can retry here when the terminal is ready.'
                  )
              : translate('sessionRecovery.ready', 'Agent exited. Your conversation is saved.')
  return (
    <div
      data-conversation-recovery
      role="status"
      className="absolute bottom-2 left-2 right-2 z-20 flex items-center gap-2 rounded-md border border-border bg-background p-2 text-xs text-foreground"
    >
      <div className="min-w-0 flex-1">
        <span>{message}</span>
        {record.prompt || record.lastAssistantMessage ? (
          <details className="mt-1 text-muted-foreground">
            <summary className="cursor-pointer">
              {translate('sessionRecovery.context', 'Last saved context')}
            </summary>
            <p className="mt-1">
              {translate(
                'sessionRecovery.contextNote',
                'Saved excerpts, not a complete handoff. Check the task checkpoint before continuing work.'
              )}
            </p>
            <div className="mt-1 max-h-48 overflow-auto scrollbar-sleek whitespace-pre-wrap break-words">
              {record.prompt ? <p>{record.prompt}</p> : null}
              {record.lastAssistantMessage ? (
                <p className="mt-2">{record.lastAssistantMessage}</p>
              ) : null}
            </div>
          </details>
        ) : null}
      </div>
      <Button
        size="sm"
        variant="secondary"
        disabled={
          redirected ||
          pending ||
          result === 'submitted' ||
          result === 'busy' ||
          result === 'uncertain'
        }
        onClick={() => void recover()}
      >
        {translate('sessionRecovery.continue', 'Continue conversation')}
      </Button>
    </div>
  )
}
