// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PaneConversationRecovery } from './PaneConversationRecovery'

const { state, recover } = vi.hoisted(() => ({
  state: {
    sleepingAgentSessionsByPaneKey: {} as Record<
      string,
      {
        requiresManualResume: boolean
        prompt?: string
        lastAssistantMessage?: string
        resumeTargetPaneKey?: string
      }
    >,
    paneForegroundAgentByPaneKey: {} as Record<
      string,
      { shellForeground: boolean; agent: string | null }
    >
  },
  recover: vi.fn(async () => 'submitted')
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (s: typeof state) => unknown) => selector(state)
}))
vi.mock('@/lib/pane-conversation-recovery', () => ({ recoverPaneConversation: recover }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  state.sleepingAgentSessionsByPaneKey = {
    'tab:leaf': {
      requiresManualResume: true,
      prompt: 'Saved request',
      lastAssistantMessage: 'Saved reply'
    }
  }
  state.paneForegroundAgentByPaneKey = { 'tab:leaf': { shellForeground: true, agent: null } }
  recover.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})
async function render() {
  await act(async () => root.render(<PaneConversationRecovery paneKey="tab:leaf" />))
}
it('shows saved context and resumes only the selected pane', async () => {
  await render()
  expect(container.textContent).toContain('Saved request')
  expect(container.textContent).toContain('Saved reply')
  expect(container.textContent).toContain('not a complete handoff')
  await act(async () => container.querySelector('button')!.click())
  expect(recover).toHaveBeenCalledExactlyOnceWith('tab:leaf')
  expect(container.textContent).toContain('waiting for the agent')
  expect(container.querySelector('button')!.disabled).toBe(true)
})
it('removes the recovery overlay when foreground evidence reports an agent', async () => {
  state.paneForegroundAgentByPaneKey['tab:leaf'] = { shellForeground: false, agent: 'codex' }
  await render()
  expect(container.textContent).toBe('')
})

it('distinguishes the pending destination from its redirected source', async () => {
  state.sleepingAgentSessionsByPaneKey['tab:leaf']!.resumeTargetPaneKey = 'tab:leaf'
  await render()
  expect(container.textContent).toContain('retry here')
  expect(container.querySelector('button')!.disabled).toBe(false)
  state.sleepingAgentSessionsByPaneKey['tab:leaf']!.resumeTargetPaneKey = 'other:leaf'
  await render()
  expect(container.textContent).toContain('in its recovery tab')
  expect(container.querySelector('button')!.disabled).toBe(true)
})
it('allows a new recovery after a later conversation checkpoint replaces the old one', async () => {
  await render()
  await act(async () => container.querySelector('button')!.click())
  state.sleepingAgentSessionsByPaneKey['tab:leaf'] = {
    requiresManualResume: true,
    prompt: 'Later request'
  }
  await render()
  expect(container.querySelector('button')!.disabled).toBe(false)
  expect(container.textContent).toContain('Later request')
})
