export type ConversationRecoveryResult =
  | 'submitted'
  | 'busy'
  | 'unavailable'
  | 'changed'
  | 'uncertain'
type RecoveryHandler = () => Promise<ConversationRecoveryResult>
const handlers = new Map<string, RecoveryHandler>()

export function registerPaneConversationRecovery(
  paneKey: string,
  handler: RecoveryHandler
): () => void {
  handlers.set(paneKey, handler)
  return () => {
    if (handlers.get(paneKey) === handler) {
      handlers.delete(paneKey)
    }
  }
}

export async function recoverPaneConversation(
  paneKey: string
): Promise<ConversationRecoveryResult> {
  return handlers.get(paneKey)?.() ?? 'unavailable'
}
