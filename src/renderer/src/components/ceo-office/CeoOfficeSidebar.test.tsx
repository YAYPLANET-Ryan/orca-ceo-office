// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CeoOfficeSidebar from './CeoOfficeSidebar'

const mocks = vi.hoisted(() => ({
  activeWorktree: {
    id: 'ceo-root',
    repoId: 'ceo-repo',
    path: 'E:/ORCA'
  } as {
    id: string
    repoId: string
    path: string
    runtimeOwnerEnvironmentId?: string
  },
  state: {
    settings: {},
    repos: [{ id: 'ceo-repo', path: 'E:/ORCA' }] as Array<{
      id: string
      path: string
      connectionId?: string
    }>,
    addNonGitFolder: vi.fn()
  },
  readRuntimeFileContent: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof mocks.state) => unknown): unknown => selector(mocks.state)
}))

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: (): typeof mocks.activeWorktree => mocks.activeWorktree
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))

describe('CeoOfficeSidebar navigation', () => {
  beforeEach(() => {
    mocks.activeWorktree.path = 'E:/ORCA'
    mocks.activeWorktree.runtimeOwnerEnvironmentId = undefined
    mocks.state.repos = [{ id: 'ceo-repo', path: 'E:/ORCA' }]
    mocks.state.addNonGitFolder.mockReset().mockResolvedValue({ id: 'oildealer' })
    mocks.readRuntimeFileContent.mockReset().mockRejectedValue(new Error('no custom manifest'))
  })

  afterEach(() => cleanup())

  it('opens a local CEO Office entry as an Orca folder workspace', async () => {
    render(<CeoOfficeSidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'OilDealer' }))

    await waitFor(() => {
      expect(mocks.state.addNonGitFolder).toHaveBeenCalledWith(
        expect.stringMatching(/02_BUSINESSES[\\/]oildealer$/)
      )
    })
  })

  it('opens an SSH CEO Office entry as a folder workspace on the owning host', async () => {
    mocks.state.repos = [{ id: 'ceo-repo', path: '/srv/orca', connectionId: 'ssh-1' }]
    render(<CeoOfficeSidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'OilDealer' }))

    await waitFor(() => {
      expect(mocks.state.addNonGitFolder).toHaveBeenCalledWith(
        expect.stringMatching(/02_BUSINESSES[\\/]oildealer$/),
        { connectionId: 'ssh-1' }
      )
    })
  })

  it('opens a paired-runtime entry as a folder workspace on the owning runtime', async () => {
    mocks.activeWorktree.path = '/srv/orca'
    mocks.activeWorktree.runtimeOwnerEnvironmentId = 'runtime-1'
    mocks.state.repos = [{ id: 'ceo-repo', path: '/srv/orca' }]
    render(<CeoOfficeSidebar />)

    fireEvent.click(screen.getByRole('button', { name: 'OilDealer' }))

    await waitFor(() => {
      expect(mocks.state.addNonGitFolder).toHaveBeenCalledWith(
        expect.stringMatching(/02_BUSINESSES[\\/]oildealer$/),
        { runtimeEnvironmentId: 'runtime-1' }
      )
    })
  })
})
