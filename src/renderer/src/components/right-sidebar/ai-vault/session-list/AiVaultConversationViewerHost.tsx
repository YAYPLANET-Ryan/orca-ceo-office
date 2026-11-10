import { Suspense } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { ModalBoundary } from '../../../../app-shell/app-root-surface-boundaries'
import { useAiVaultConversationViewerSession } from '../session-actions/ai-vault-conversation-viewer'

const AiVaultConversationViewerDialog = lazy(() => import('./AiVaultConversationViewerDialog'))

/** Mounts the read-only saved-conversation viewer only while a session is open in it. */
export default function AiVaultConversationViewerHost(): React.JSX.Element | null {
  const session = useAiVaultConversationViewerSession()
  if (!session) {
    return null
  }
  return (
    <ModalBoundary boundaryId="modal.ai-vault-conversation-viewer" resetKey={session.id}>
      <Suspense fallback={null}>
        <AiVaultConversationViewerDialog session={session} />
      </Suspense>
    </ModalBoundary>
  )
}
