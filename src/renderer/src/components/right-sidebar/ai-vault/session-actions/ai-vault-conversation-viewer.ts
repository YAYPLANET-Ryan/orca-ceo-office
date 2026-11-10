import { useSyncExternalStore } from 'react'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { canOpenAiVaultSessionLogInOrca } from './ai-vault-session-path-actions'

/** Read-only viewing reads the stored transcript file; it never launches or resumes the agent CLI. */
export const AI_VAULT_CONVERSATION_VIEW_LIMIT = 400

export type AiVaultConversationViewerEntry = {
  id: string
  role: NativeChatMessage['role']
  text: string
  timestamp: number | null
}

let openSession: AiVaultSession | null = null
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function canViewAiVaultConversation(
  session: Pick<AiVaultSession, 'agent' | 'filePath' | 'executionHostId'>
): boolean {
  return (
    (session.agent === 'claude' || session.agent === 'codex') &&
    canOpenAiVaultSessionLogInOrca(session)
  )
}

export function openAiVaultConversationViewer(session: AiVaultSession): void {
  openSession = session
  emit()
}

export function closeAiVaultConversationViewer(): void {
  openSession = null
  emit()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useAiVaultConversationViewerSession(): AiVaultSession | null {
  return useSyncExternalStore(
    subscribe,
    () => openSession,
    () => null
  )
}

function blockText(block: NativeChatMessage['blocks'][number]): string {
  if (block.type === 'text') {
    return block.text
  }
  // Tool calls are named; tool results, images, subagents and background tasks stay out of the read-only view.
  return block.type === 'tool-call' ? `[tool] ${block.name}` : ''
}

/** Flattens stored messages to plain read-only lines; tool output and reasoning stay out of the view. */
export function aiVaultConversationViewerEntries(
  messages: readonly NativeChatMessage[]
): AiVaultConversationViewerEntry[] {
  const entries: AiVaultConversationViewerEntry[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue
    }
    const text = message.blocks
      .map(blockText)
      .filter((part) => part.trim().length > 0)
      .join('\n')
      .trim()
    if (text.length > 0) {
      entries.push({ id: message.id, role: message.role, text, timestamp: message.timestamp })
    }
  }
  return entries
}
