import { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import {
  AI_VAULT_CONVERSATION_VIEW_LIMIT,
  aiVaultConversationViewerEntries,
  closeAiVaultConversationViewer,
  type AiVaultConversationViewerEntry
} from '../session-actions/ai-vault-conversation-viewer'

type ViewerState =
  | { kind: 'loading' }
  | { kind: 'ready'; entries: AiVaultConversationViewerEntry[] }
  | { kind: 'error'; message: string }

/** Shows a stored Claude/Codex conversation read-only, without the agent CLI and without resuming it. */
export default function AiVaultConversationViewerDialog({
  session
}: {
  session: AiVaultSession
}): React.JSX.Element {
  const t = useTranslate()
  const [state, setState] = useState<ViewerState>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    window.api.nativeChat
      .readSession(
        session.agent,
        session.sessionId,
        AI_VAULT_CONVERSATION_VIEW_LIMIT,
        session.filePath
      )
      .then((result) => {
        if (cancelled) {
          return
        }
        setState(
          'error' in result
            ? { kind: 'error', message: result.error }
            : { kind: 'ready', entries: aiVaultConversationViewerEntries(result.messages) }
        )
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error)
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [session.agent, session.sessionId, session.filePath])

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          closeAiVaultConversationViewer()
        }
      }}
    >
      <DialogContent className="flex h-[min(720px,calc(100vh-4rem))] flex-col overflow-hidden sm:max-w-[720px]">
        <DialogHeader>
          <DialogTitle>{session.title}</DialogTitle>
          <DialogDescription>
            {t(
              'auto.components.right.sidebar.AiVaultConversationViewer.readOnly',
              'Read-only view of the saved conversation. Viewing does not start or resume the agent.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div
          className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek pr-1"
          data-testid="ai-vault-conversation-viewer"
        >
          {state.kind === 'loading' ? (
            <p className="text-sm text-muted-foreground">
              {t('auto.components.right.sidebar.AiVaultConversationViewer.loading', 'Loading…')}
            </p>
          ) : state.kind === 'error' ? (
            <p className="text-sm text-destructive">
              {t(
                'auto.components.right.sidebar.AiVaultConversationViewer.error',
                'Could not read the saved conversation: {{value0}}',
                { value0: state.message }
              )}
            </p>
          ) : state.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t(
                'auto.components.right.sidebar.AiVaultConversationViewer.empty',
                'No messages in this conversation.'
              )}
            </p>
          ) : (
            <ol className="flex flex-col gap-3">
              {state.entries.map((entry) => (
                <li
                  key={entry.id}
                  data-role={entry.role}
                  className={
                    entry.role === 'user'
                      ? 'rounded-md border border-border bg-muted/40 px-3 py-2'
                      : 'px-3 py-1'
                  }
                >
                  <div className="mb-1 text-xs font-medium text-muted-foreground">
                    {entry.role === 'user'
                      ? t('auto.components.right.sidebar.AiVaultConversationViewer.user', 'You')
                      : t(
                          'auto.components.right.sidebar.AiVaultConversationViewer.assistant',
                          'Agent'
                        )}
                  </div>
                  <div className="whitespace-pre-wrap break-words text-sm">{entry.text}</div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
