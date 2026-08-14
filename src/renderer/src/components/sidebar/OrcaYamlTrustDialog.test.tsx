// @vitest-environment happy-dom

import { renderToStaticMarkup } from 'react-dom/server'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  state: {
    activeModal: 'confirm-orca-yaml-hooks' as string | null,
    modalData: {} as Record<string, unknown>,
    closeModal: vi.fn(),
    markOrcaHookScriptConfirmed: vi.fn(),
    markOrcaHookRepoAlwaysTrusted: vi.fn()
  }
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    {
      getState: () => mocks.state
    }
  )
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) => (
    <button {...props}>{children}</button>
  )
}))

// Why: fall back to English defaults so this test doesn't depend on locale files
// being loaded; the bug is missing JSX whitespace around those fragments.
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [key, value]) => text.replaceAll(`{{${key}}}`, value),
      fallback
    )
}))

function decodeHtml(html: string): string {
  return html
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

describe('OrcaYamlTrustDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.activeModal = 'confirm-orca-yaml-hooks'
    mocks.state.modalData = {
      repoId: 'repo-1',
      repoName: 'orca',
      scriptKind: 'setup',
      scriptContent: 'node config/scripts/run-internal-dev-setup.mjs\npnpm install',
      contentHash: 'hash-1',
      previouslyApproved: false
    }
  })

  afterEach(() => cleanup())

  it('keeps spaces around orca.yaml and the repo name in the first-run copy', async () => {
    const { default: OrcaYamlTrustDialog } = await import('./OrcaYamlTrustDialog')
    const text = decodeHtml(renderToStaticMarkup(<OrcaYamlTrustDialog />)).replace(/<[^>]+>/g, '')

    expect(text).toContain("This repository's orca.yaml runs on your machine")
    expect(text).toContain('Only run if you trust orca.')
    expect(text).toContain('Always trust orca.yaml in orca')
    expect(text).not.toContain("repository'sorca.yaml")
    expect(text).not.toContain('trustorca')
    expect(text).not.toContain('trustorca.yaml')
    expect(text).not.toContain('inorca')
  })

  it('keeps spaces around orca.yaml when the script changed since last approval', async () => {
    mocks.state.modalData = {
      ...mocks.state.modalData,
      previouslyApproved: true
    }
    const { default: OrcaYamlTrustDialog } = await import('./OrcaYamlTrustDialog')
    const text = decodeHtml(renderToStaticMarkup(<OrcaYamlTrustDialog />)).replace(/<[^>]+>/g, '')

    expect(text).toContain('orca.yaml changed since you last approved')
    expect(text).toContain('Always trust orca.yaml in orca')
    expect(text).not.toContain('Always trustorca.yaml')
    expect(text).not.toContain('inorca')
  })

  it('explains the workspace agent launcher without calling it an orca.yaml hook', async () => {
    mocks.state.modalData = {
      repoId: 'repo-1',
      repoName: 'ORCA',
      scriptKind: 'agentLauncher',
      scriptContent: 'E:/ORCA/scripts/Start-OrcaAgent.cmd'
    }
    const { default: OrcaYamlTrustDialog } = await import('./OrcaYamlTrustDialog')
    const text = decodeHtml(renderToStaticMarkup(<OrcaYamlTrustDialog />)).replace(/<[^>]+>/g, '')

    expect(text).toContain('Run workspace agent launcher from ORCA?')
    expect(text).toContain('Only run it if you trust ORCA.')
    expect(text).toContain('Always trust repository automation in ORCA')
    expect(text).toContain('Use launcher')
  })

  it('treats one-time launcher approval as one-time trust', async () => {
    const onResolve = vi.fn()
    mocks.state.modalData = {
      repoId: 'repo-1',
      repoName: 'ORCA',
      scriptKind: 'agentLauncher',
      scriptContent: 'E:/ORCA/scripts/Start-OrcaAgent.cmd',
      contentHash: 'must-not-persist',
      onResolve
    }
    const { default: OrcaYamlTrustDialog } = await import('./OrcaYamlTrustDialog')
    render(<OrcaYamlTrustDialog />)

    fireEvent.click(screen.getByRole('button', { name: 'Use launcher' }))

    expect(onResolve).toHaveBeenCalledWith('run')
    expect(mocks.state.markOrcaHookScriptConfirmed).not.toHaveBeenCalled()
    expect(mocks.state.markOrcaHookRepoAlwaysTrusted).not.toHaveBeenCalled()
  })
})
