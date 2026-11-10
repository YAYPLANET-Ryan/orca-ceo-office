// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import AiVaultConversationViewerDialog from './AiVaultConversationViewerDialog'
import {
  aiVaultConversationViewerEntries,
  canViewAiVaultConversation,
  closeAiVaultConversationViewer,
  openAiVaultConversationViewer,
  useAiVaultConversationViewerSession
} from '../session-actions/ai-vault-conversation-viewer'

const readSession = vi.fn()

function makeSession(overrides: Partial<AiVaultSession> = {}): AiVaultSession {
  return {
    id: 'local:codex:saved-session:/tmp/rollout-saved.jsonl',
    executionHostId: 'local',
    agent: 'codex',
    sessionId: 'saved-session',
    title: 'Saved conversation',
    cwd: '/repo',
    branch: null,
    model: null,
    filePath: '/tmp/rollout-saved.jsonl',
    codexHome: null,
    createdAt: null,
    updatedAt: null,
    modifiedAt: '2026-11-10T10:00:00.000Z',
    messageCount: 3,
    totalTokens: 0,
    previewMessages: [],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: 'codex resume saved-session',
    subagent: null,
    ...overrides
  }
}

function message(
  id: string,
  role: NativeChatMessage['role'],
  blocks: NativeChatMessage['blocks']
): NativeChatMessage {
  return { id, role, blocks, timestamp: 1, source: 'transcript' }
}

const STORED: NativeChatMessage[] = [
  message('m1', 'user', [{ type: 'text', text: 'Summarize the build status' }]),
  message('m2', 'reasoning', [{ type: 'text', text: 'hidden reasoning' }]),
  message('m3', 'assistant', [
    { type: 'text', text: 'The build passes.' },
    { type: 'tool-call', name: 'shell', input: { cmd: 'ls' } }
  ]),
  message('m4', 'tool', [{ type: 'text', text: 'tool output' }])
]

beforeEach(() => {
  readSession.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { nativeChat: { readSession } }
  })
})

afterEach(() => {
  cleanup()
  act(() => closeAiVaultConversationViewer())
})

describe('aiVaultConversationViewerEntries', () => {
  it('keeps user and assistant text, names tool calls, and drops reasoning and tool output', () => {
    expect(aiVaultConversationViewerEntries(STORED)).toEqual([
      { id: 'm1', role: 'user', text: 'Summarize the build status', timestamp: 1 },
      { id: 'm3', role: 'assistant', text: 'The build passes.\n[tool] shell', timestamp: 1 }
    ])
  })
})

describe('canViewAiVaultConversation', () => {
  it('offers viewing only for local Claude and Codex transcripts', () => {
    expect(canViewAiVaultConversation(makeSession())).toBe(true)
    expect(canViewAiVaultConversation(makeSession({ agent: 'claude' }))).toBe(true)
    expect(canViewAiVaultConversation(makeSession({ agent: 'gemini' }))).toBe(false)
    expect(canViewAiVaultConversation(makeSession({ executionHostId: 'ssh:remote-box' }))).toBe(
      false
    )
  })
})

describe('AiVaultConversationViewerDialog', () => {
  it('reads the stored transcript file read-only and renders the conversation', async () => {
    readSession.mockResolvedValue({ messages: STORED })
    render(<AiVaultConversationViewerDialog session={makeSession()} />)
    await waitFor(() =>
      expect(screen.getByText('The build passes.', { exact: false })).toBeVisible()
    )
    expect(screen.getByText('Summarize the build status')).toBeVisible()
    expect(screen.queryByText('hidden reasoning')).toBeNull()
    expect(screen.queryByText('tool output')).toBeNull()
    expect(readSession).toHaveBeenCalledWith(
      'codex',
      'saved-session',
      expect.any(Number),
      '/tmp/rollout-saved.jsonl'
    )
  })

  it('reports a transcript the reader cannot open instead of an empty conversation', async () => {
    readSession.mockResolvedValue({ error: 'transcript missing', notFound: true })
    render(<AiVaultConversationViewerDialog session={makeSession()} />)
    await waitFor(() => expect(screen.getByText(/transcript missing/)).toBeVisible())
  })

  it('opens and closes through the viewer store', () => {
    function Probe(): React.JSX.Element {
      return <span>{useAiVaultConversationViewerSession()?.sessionId ?? 'none'}</span>
    }
    render(<Probe />)
    expect(screen.getByText('none')).toBeInTheDocument()
    act(() => openAiVaultConversationViewer(makeSession()))
    expect(screen.getByText('saved-session')).toBeInTheDocument()
    act(() => closeAiVaultConversationViewer())
    expect(screen.getByText('none')).toBeInTheDocument()
  })
})
