import { describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import type { Store } from '../../../persistence'
import { persistAdmittedStablePaneBinding } from './stable-owner'

const tabId = 'tab-binding-commit'
const leafId = '11111111-1111-4111-8111-111111111111'
const worktreeId = 'worktree-binding-commit'
const paneKey = makePaneKey(tabId, leafId)

function fixture(options: {
  ptyId?: string
  incarnationId?: string
  missingTab?: boolean
  missingLeaf?: boolean
  retired?: boolean
  connectionId?: string
  resultIncarnationId?: string
}) {
  const persistPtyBinding = vi.fn(() => false)
  const flushOrThrow = vi.fn()
  const getWorkspaceSession = vi.fn(() => ({
    tabsByWorktree: { [worktreeId]: options.missingTab ? [] : [{ id: tabId, worktreeId }] },
    terminalLayoutsByTabId: {
      [tabId]: {
        root: options.missingLeaf ? null : { type: 'leaf', leafId },
        ptyIdsByLeafId: options.ptyId ? { [leafId]: options.ptyId } : {}
      }
    },
    terminalPtyIncarnationsByPaneKey: options.incarnationId
      ? { [paneKey]: options.incarnationId }
      : {},
    terminalSurfaceTombstonesByPaneKey: options.retired ? { [paneKey]: { retiredAt: 1 } } : {}
  }))
  const result = {
    id: 'pty-current',
    incarnationId: options.resultIncarnationId,
    isReattach: true
  }
  const commit = () =>
    persistAdmittedStablePaneBinding({
      store: { persistPtyBinding, getWorkspaceSession, flushOrThrow } as unknown as Store,
      owner: {
        tabId,
        leafId,
        ptyId: 'pty-current',
        hasPersistedBinding: true,
        persistedIncarnationId: 'inc-old'
      },
      result,
      worktreeId,
      startupCwd: undefined,
      connectionId: options.connectionId
    })
  return { commit, persistPtyBinding, getWorkspaceSession, flushOrThrow }
}

describe('stable pane binding compare-and-swap reconciliation', () => {
  it.each([undefined, 'ssh-fixture'])(
    'accepts an already saved exact attachment on host %s',
    (connectionId) => {
      const { commit, persistPtyBinding, getWorkspaceSession, flushOrThrow } = fixture({
        ptyId: 'pty-current',
        incarnationId: 'inc-current',
        resultIncarnationId: 'inc-current',
        connectionId
      })
      expect(commit()).toBe(true)
      expect(persistPtyBinding).toHaveBeenCalledOnce()
      expect(flushOrThrow).toHaveBeenCalledOnce()
      expect(getWorkspaceSession).toHaveBeenCalledOnce()
      expect(getWorkspaceSession).toHaveBeenCalledWith(
        connectionId ? toSshExecutionHostId(connectionId) : undefined
      )
    }
  )

  it.each([
    { ptyId: 'pty-other', incarnationId: 'inc-current' },
    { ptyId: 'pty-current', incarnationId: 'inc-other' },
    { ptyId: 'pty-current' },
    {},
    { ptyId: 'pty-current', incarnationId: 'inc-current', missingTab: true },
    { ptyId: 'pty-current', incarnationId: 'inc-current', missingLeaf: true },
    { ptyId: 'pty-current', incarnationId: 'inc-current', retired: true }
  ])('refuses a missing, closed or different owner: %j', (binding) => {
    const { commit, persistPtyBinding, flushOrThrow } = fixture({
      ...binding,
      resultIncarnationId: 'inc-current'
    })
    expect(commit).toThrow('terminal_pane_owner_changed')
    expect(persistPtyBinding).toHaveBeenCalledOnce()
    expect(flushOrThrow).not.toHaveBeenCalled()
  })

  it('does not assume a legacy attachment without generation proof is the same process', () => {
    const { commit } = fixture({ ptyId: 'pty-current' })
    expect(commit).toThrow('terminal_pane_owner_changed')
  })

  it('propagates a flush failure instead of publishing an unpersisted attachment', () => {
    const { commit, flushOrThrow } = fixture({
      ptyId: 'pty-current',
      incarnationId: 'inc-current',
      resultIncarnationId: 'inc-current'
    })
    const error = new Error('synthetic storage failure')
    flushOrThrow.mockImplementation(() => {
      throw error
    })
    expect(commit).toThrow(error)
  })
})
