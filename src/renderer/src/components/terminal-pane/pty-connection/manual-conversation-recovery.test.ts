import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installManualConversationRecovery } from './manual-conversation-recovery'
import { recoverPaneConversation } from '@/lib/pane-conversation-recovery'
import { setDriverForPty } from '@/lib/pane-manager/mobile-driver-state'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

const { state } = vi.hoisted(() => ({
  state: { agentStatusByPaneKey: {} as Record<string, unknown>, codexRestartNoticeByPtyId: {} }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
const teardowns: (() => void)[] = []
afterEach(() => {
  teardowns.splice(0).forEach((f) => f())
  vi.unstubAllGlobals()
})
beforeEach(() => {
  state.agentStatusByPaneKey = {}
})
function setup() {
  const record = {
    resumeTargetPaneKey: undefined as string | undefined,
    requiresManualResume: true,
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'exact-id' }
  }
  const confirm = vi.fn(async (): Promise<string | null> => 'powershell.exe')
  const send = vi.fn(async () => true)
  const session = {
    cacheKey: 'manual:leaf',
    deps: { tabId: 'manual', worktreeId: 'wt' },
    disposed: false,
    waitTeardowns: teardowns,
    recoveryShellInputAt: 1,
    lastTerminalInputAt: 1,
    transportStreamGeneration: 1,
    transport: { getPtyId: () => 'pty', sendInputAccepted: send },
    isForegroundTrackingAllowed: () => true,
    getSleepingRecordForPane: () => ({ paneKey: 'manual:leaf', record }),
    buildColdRestoreAgentResumeStartup: vi.fn(() => ({
      agent: 'codex',
      command: 'codex resume exact-id',
      resumeProviderSession: record.providerSession
    })),
    startAcceptedInferredCommand: vi.fn()
  } as unknown as ConnectPanePtySession
  vi.stubGlobal('window', { api: { pty: { confirmForegroundProcess: confirm } } })
  installManualConversationRecovery(session)
  return { session, record, confirm, send }
}
it('resumes the exact conversation once in the existing pane and keeps its record', async () => {
  const f = setup()
  expect(await recoverPaneConversation('manual:leaf')).toBe('submitted')
  expect(f.send).toHaveBeenCalledExactlyOnceWith('codex resume exact-id\r')
  expect(f.session.buildColdRestoreAgentResumeStartup).toHaveBeenCalledWith({ manual: true })
  expect(f.record.requiresManualResume).toBe(true)
  expect(await recoverPaneConversation('manual:leaf')).toBe('busy')
})
it('does not append a resume command to user input', async () => {
  const f = setup()
  f.session.lastTerminalInputAt = 2
  expect(await recoverPaneConversation('manual:leaf')).toBe('changed')
  expect(f.send).not.toHaveBeenCalled()
})

it('does not resume a redirected source in the wrong pane', async () => {
  const f = setup()
  f.record.resumeTargetPaneKey = 'another:leaf'
  expect(await recoverPaneConversation('manual:leaf')).toBe('unavailable')
  expect(f.send).not.toHaveBeenCalled()
})
it.each([null, 'claude.exe', 'node.exe'])(
  'refuses unverifiable or occupied foreground %s',
  async (name) => {
    const f = setup()
    f.confirm.mockResolvedValue(name)
    expect(await recoverPaneConversation('manual:leaf')).toBe('unavailable')
    expect(f.send).not.toHaveBeenCalled()
  }
)
it.each(['disposed', 'transportStreamGeneration', 'lastTerminalInputAt'])(
  'fences a changed %s during confirmation',
  async (key) => {
    const f = setup()
    f.confirm.mockImplementation(async () => {
      f.session[key] = key === 'disposed' ? true : 2
      return 'powershell.exe'
    })
    expect(await recoverPaneConversation('manual:leaf')).toBe('changed')
    expect(f.send).not.toHaveBeenCalled()
  }
)
it('prevents concurrent confirmation and tolerates unavailable transport', async () => {
  const f = setup()
  let resolve!: (name: string) => void
  f.confirm.mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r
      })
  )
  const first = recoverPaneConversation('manual:leaf')
  expect(await recoverPaneConversation('manual:leaf')).toBe('busy')
  resolve('powershell.exe')
  await first
  teardowns.splice(0).forEach((fn) => fn())
  expect(await recoverPaneConversation('manual:leaf')).toBe('unavailable')
})
it('does not route a local recovery into a remote pane', async () => {
  const f = setup()
  f.session.isForegroundTrackingAllowed = () => false
  expect(await recoverPaneConversation('manual:leaf')).toBe('unavailable')
  expect(f.confirm).not.toHaveBeenCalled()
})

it('does not resend after an ambiguous transport failure', async () => {
  const f = setup()
  f.send.mockRejectedValue(new Error('ack lost'))
  expect(await recoverPaneConversation('manual:leaf')).toBe('uncertain')
  expect(await recoverPaneConversation('manual:leaf')).toBe('busy')
  expect(f.send).toHaveBeenCalledTimes(1)
})
it('permits another attempt when transport explicitly rejected delivery', async () => {
  const f = setup()
  f.send.mockResolvedValueOnce(false)
  expect(await recoverPaneConversation('manual:leaf')).toBe('unavailable')
  expect(await recoverPaneConversation('manual:leaf')).toBe('submitted')
})

it('honors the mobile input lock', async () => {
  const f = setup()
  setDriverForPty('pty', { kind: 'mobile' } as never)
  try {
    expect(await recoverPaneConversation('manual:leaf')).toBe('unavailable')
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    setDriverForPty('pty', { kind: 'idle' })
  }
})

it('permits explicit recovery after a newly confirmed command exit', async () => {
  const f = setup()
  expect(await recoverPaneConversation('manual:leaf')).toBe('submitted')
  f.session.recoveryShellSequence = 1
  expect(await recoverPaneConversation('manual:leaf')).toBe('submitted')
  expect(f.send).toHaveBeenCalledTimes(2)
})

it('bounds an unresponsive foreground probe without sending input', async () => {
  vi.useFakeTimers()
  try {
    const f = setup()
    f.confirm.mockImplementation(() => new Promise(() => {}))
    const result = recoverPaneConversation('manual:leaf')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toBe('unavailable')
    expect(f.send).not.toHaveBeenCalled()
  } finally {
    vi.useRealTimers()
  }
})
it('never retries an acknowledgement timeout automatically', async () => {
  vi.useFakeTimers()
  try {
    const f = setup()
    f.send.mockImplementation(() => new Promise(() => {}))
    const result = recoverPaneConversation('manual:leaf')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await result).toBe('uncertain')
    expect(await recoverPaneConversation('manual:leaf')).toBe('busy')
  } finally {
    vi.useRealTimers()
  }
})

it('refuses a startup plan for a different conversation', async () => {
  const f = setup()
  f.session.buildColdRestoreAgentResumeStartup = () => ({
    agent: 'codex',
    command: 'codex resume other',
    resumeProviderSession: { key: 'session_id', id: 'other' }
  })
  expect(await recoverPaneConversation('manual:leaf')).toBe('unavailable')
  expect(f.send).not.toHaveBeenCalled()
})
