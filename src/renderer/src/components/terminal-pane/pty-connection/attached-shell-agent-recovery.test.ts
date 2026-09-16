import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConnectPanePtySession } from './connect-pane-pty-session'
import { createAttachedShellAgentRecovery } from './attached-shell-agent-recovery'
import { bindBuildColdRestoreAgentResumeStartup } from './cold-restore-resume-startup'

const { state, reconcile } = vi.hoisted(() => ({
  state: {
    agentStatusByPaneKey: {} as Record<string, unknown>,
    dropAgentStatus: vi.fn(),
    markSleepingAgentSessionExited: vi.fn()
  },
  reconcile: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))

afterEach(() => vi.unstubAllGlobals())

function setup() {
  const record = { requiresManualResume: false }
  const getPtyId = vi.fn(() => 'original-pty')
  const sendInputAccepted = vi.fn(async () => true)
  const startAcceptedInferredCommand = vi.fn()
  const session = {
    cacheKey: 'tab:leaf',
    disposed: false,
    transportStreamGeneration: 1,
    lastTerminalInputAt: -Infinity,
    transport: { getPtyId, sendInputAccepted },
    getSleepingRecordForPane: () => ({ paneKey: 'tab:leaf', record }),
    isLegacyWorkerAutomaticResumeBlocked: () => false,
    buildColdRestoreAgentResumeStartup: () => ({
      agent: 'codex',
      command: 'codex resume exact-id'
    }),
    startAcceptedInferredCommand
  } as unknown as ConnectPanePtySession
  state.agentStatusByPaneKey['tab:leaf'] = { state: 'done', updatedAt: Date.now() }
  return { session, record, getPtyId, sendInputAccepted, startAcceptedInferredCommand }
}

beforeEach(() => {
  vi.clearAllMocks()
  state.agentStatusByPaneKey = {}
  vi.stubGlobal('window', { api: { agentStatus: { reconcileEndedProcess: reconcile } } })
})

describe('attached shell recovery safety', () => {
  it('sends one exact resume command for a restorable completed turn', async () => {
    const f = setup()
    const recover = createAttachedShellAgentRecovery(f.session)
    recover()
    recover()
    await Promise.resolve()
    expect(f.sendInputAccepted).toHaveBeenCalledExactlyOnceWith('codex resume exact-id\r')
    expect(f.startAcceptedInferredCommand).toHaveBeenCalledExactlyOnceWith('codex')
    expect(state.dropAgentStatus).not.toHaveBeenCalled()
  })

  it('keeps a fresh working exit for manual resume instead of silently restarting it', () => {
    const f = setup()
    state.agentStatusByPaneKey['tab:leaf'] = { state: 'working', updatedAt: Date.now() }
    const recover = createAttachedShellAgentRecovery(f.session)
    recover()
    recover()
    expect(f.sendInputAccepted).not.toHaveBeenCalled()
    expect(state.markSleepingAgentSessionExited).toHaveBeenCalledExactlyOnceWith('tab:leaf')
    expect(state.dropAgentStatus).toHaveBeenCalledExactlyOnceWith('tab:leaf')
  })

  it('does not auto-resume an observed exit on warm or cold restore', () => {
    const f = setup()
    f.record.requiresManualResume = true
    bindBuildColdRestoreAgentResumeStartup(f.session)
    expect(f.session.buildColdRestoreAgentResumeStartup()).toBeNull()
    expect(f.session.shouldRequireManualColdRestoreAgentResume()).toBe(true)
    createAttachedShellAgentRecovery(f.session)()
    expect(f.sendInputAccepted).not.toHaveBeenCalled()
  })

  it('never writes to a disposed pane', () => {
    const f = setup()
    f.session.disposed = true
    createAttachedShellAgentRecovery(f.session)()
    expect(f.sendInputAccepted).not.toHaveBeenCalled()
    expect(state.dropAgentStatus).not.toHaveBeenCalled()
  })

  it.each(['dispose', 'pty', 'generation', 'input', 'status', 'record'] as const)(
    'ignores a rejected input acknowledgement after a newer %s',
    async (change) => {
      const f = setup()
      let acknowledge!: (accepted: boolean) => void
      f.sendInputAccepted.mockImplementation(
        () =>
          new Promise((resolve) => {
            acknowledge = resolve
          })
      )
      createAttachedShellAgentRecovery(f.session)()
      if (change === 'dispose') {
        f.session.disposed = true
      }
      if (change === 'pty') {
        f.getPtyId.mockReturnValue('replacement-pty')
      }
      if (change === 'generation') {
        f.session.transportStreamGeneration += 1
      }
      if (change === 'input') {
        f.session.lastTerminalInputAt = 100
      }
      if (change === 'status') {
        state.agentStatusByPaneKey['tab:leaf'] = { state: 'working' }
      }
      if (change === 'record') {
        f.session.getSleepingRecordForPane = () => ({ paneKey: 'tab:leaf', record: {} })
      }
      acknowledge(false)
      await Promise.resolve()
      expect(state.dropAgentStatus).not.toHaveBeenCalled()
      expect(state.markSleepingAgentSessionExited).not.toHaveBeenCalled()
      expect(reconcile).not.toHaveBeenCalled()
      expect(f.startAcceptedInferredCommand).not.toHaveBeenCalled()
    }
  )

  it('preserves a failed resume for manual recovery and does not retry in a loop', async () => {
    const f = setup()
    f.sendInputAccepted.mockResolvedValue(false)
    const recover = createAttachedShellAgentRecovery(f.session)
    recover()
    await Promise.resolve()
    recover()
    expect(f.sendInputAccepted).toHaveBeenCalledTimes(1)
    expect(state.markSleepingAgentSessionExited).toHaveBeenCalledExactlyOnceWith('tab:leaf')
  })
})
