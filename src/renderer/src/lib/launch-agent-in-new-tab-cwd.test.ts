import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockQueueTabInitialCwd = vi.fn()
const mockLaunchAgentInWebHostTab = vi.fn()
const mockIsWebRuntimeSessionActive = vi.fn()
const mockCallRuntimeRpc = vi.fn()

const store = {
  settings: {
    agentCmdOverrides: {},
    agentDefaultArgs: {},
    agentDefaultEnv: {},
    activeRuntimeEnvironmentId: null as string | null
  },
  repos: [] as {
    id: string
    path: string
    connectionId?: string
    executionHostId?: string | null
  }[],
  allWorktrees: vi.fn(() => [] as { id: string; repoId: string; path: string }[]),
  trustedOrcaHooks: {} as Record<string, { all?: { approvedAt: number } }>,
  folderWorkspaces: [] as {
    id: string
    projectGroupId: string
    folderPath: string
    connectionId?: string | null
    executionHostId?: string | null
  }[],
  projectGroups: [] as { id: string; connectionId?: string | null }[],
  tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] },
  openFiles: [] as { id: string; worktreeId: string }[],
  browserTabsByWorktree: {} as Record<string, { id: string }[]>,
  tabBarOrderByWorktree: {} as Record<string, string[]>,
  createTab: vi.fn(() => ({ id: 'tab-1' })),
  queueTabInitialCwd: mockQueueTabInitialCwd,
  queueTabStartupCommand: vi.fn(),
  setActiveTabType: vi.fn(),
  setTabBarOrder: vi.fn()
}

vi.mock('@/store', () => ({
  useAppStore: { getState: () => store }
}))

vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))

vi.mock('@/lib/connection-context', () => ({
  getConnectionIdFromState: () => null
}))

vi.mock('@/lib/native-chat-transcript-readability', () => ({
  isNativeChatTranscriptLocalReadable: () => true
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  isWebRuntimeSessionActive: mockIsWebRuntimeSessionActive
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: mockCallRuntimeRpc
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => 'web-runtime'
}))

vi.mock('@/lib/launch-agent-web-host-tab', () => ({
  launchAgentInWebHostTab: mockLaunchAgentInWebHostTab
}))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: (_stored: unknown, terminalIds: string[]) => terminalIds
}))

vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))

vi.mock('@/components/native-chat/native-chat-session-option-cache', () => ({
  seedNativeChatAppliedSessionOptions: vi.fn()
}))

describe('launchAgentInNewTab initial cwd', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockIsWebRuntimeSessionActive.mockReturnValue(false)
    mockLaunchAgentInWebHostTab.mockResolvedValue({
      delivered: true,
      failureNotified: false
    })
    store.repos = []
    store.allWorktrees.mockReturnValue([])
    store.trustedOrcaHooks = {}
    store.folderWorkspaces = []
    store.projectGroups = []
    mockCallRuntimeRpc.mockReset()
  })

  it('falls back to the bare command when an older paired runtime lacks the resolver', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    mockCallRuntimeRpc.mockRejectedValue(new Error('Unknown method'))
    store.repos = [{ id: 'repo-1', path: '/repo' }]
    store.trustedOrcaHooks = { 'repo-1': { all: { approvedAt: 1 } } }
    store.allWorktrees.mockReturnValue([{ id: 'wt-1', repoId: 'repo-1', path: '/repo/project' }])
    const { launchAgentInNewTabWithWorkspaceLauncher } =
      await import('./launch-agent-with-workspace-launcher')

    await expect(
      launchAgentInNewTabWithWorkspaceLauncher({ agent: 'claude', worktreeId: 'wt-1' })
    ).resolves.toEqual(expect.objectContaining({ tabId: null }))
    expect(mockLaunchAgentInWebHostTab).toHaveBeenCalledTimes(1)
    expect(mockLaunchAgentInWebHostTab).toHaveBeenCalledWith(
      expect.objectContaining({
        startupPlan: expect.objectContaining({
          launchCommand: expect.stringMatching(/^claude(?:\s|$)/)
        })
      })
    )
    expect(store.createTab).not.toHaveBeenCalled()
  })

  it('waits for workspace launcher resolution before creating exactly one tab', async () => {
    let finishResolution!: (value: { workspaceRoot: string; launcherPath: string }) => void
    const resolution = new Promise<{ workspaceRoot: string; launcherPath: string }>((resolve) => {
      finishResolution = resolve
    })
    store.repos = [{ id: 'repo-1', path: '/repo' }]
    store.trustedOrcaHooks = { 'repo-1': { all: { approvedAt: 1 } } }
    store.allWorktrees.mockReturnValue([{ id: 'wt-1', repoId: 'repo-1', path: '/repo/project' }])
    const resolveWorkspaceAgentLauncher = vi.fn(() => resolution)
    vi.stubGlobal('window', { api: { fs: { resolveWorkspaceAgentLauncher } } })
    const { launchAgentInNewTabWithWorkspaceLauncher } =
      await import('./launch-agent-with-workspace-launcher')

    const launch = launchAgentInNewTabWithWorkspaceLauncher({
      agent: 'codex',
      worktreeId: 'wt-1'
    })
    expect(store.createTab).not.toHaveBeenCalled()

    finishResolution({
      workspaceRoot: '/repo',
      launcherPath: '/repo/scripts/start-orca-agent'
    })
    await expect(launch).resolves.toEqual(expect.objectContaining({ tabId: 'tab-1' }))
    expect(store.createTab).toHaveBeenCalledTimes(1)
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({
        command: expect.stringMatching(
          /^'\/repo\/scripts\/start-orca-agent' '--agent' 'codex'(?:\s|$)/
        )
      })
    )
  })

  it('falls back when a local workspace contract is present but untrusted', async () => {
    store.repos = [{ id: 'repo-1', path: '/repo' }]
    store.allWorktrees.mockReturnValue([{ id: 'wt-1', repoId: 'repo-1', path: '/repo/project' }])
    const resolveWorkspaceAgentLauncher = vi.fn().mockResolvedValue({
      workspaceRoot: '/repo',
      launcherPath: '/repo/scripts/start-orca-agent'
    })
    vi.stubGlobal('window', { api: { fs: { resolveWorkspaceAgentLauncher } } })
    const { launchAgentInNewTabWithWorkspaceLauncher } =
      await import('./launch-agent-with-workspace-launcher')

    await launchAgentInNewTabWithWorkspaceLauncher({ agent: 'codex', worktreeId: 'wt-1' })

    expect(resolveWorkspaceAgentLauncher).toHaveBeenCalled()
    expect(store.queueTabStartupCommand).toHaveBeenCalledWith(
      'tab-1',
      expect.objectContaining({ command: expect.not.stringContaining('start-orca-agent') })
    )
  })

  it('uses the paired runtime folder selector for a trusted folder workspace', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    mockCallRuntimeRpc.mockResolvedValue({
      workspaceRoot: '/repo',
      launcherPath: '/repo/scripts/start-orca-agent'
    })
    store.repos = [{ id: 'repo-1', path: '/repo', executionHostId: 'runtime:web-runtime' }]
    store.trustedOrcaHooks = { 'repo-1': { all: { approvedAt: 1 } } }
    store.folderWorkspaces = [
      {
        id: 'folder-1',
        projectGroupId: 'group-1',
        folderPath: '/repo/projects',
        executionHostId: 'runtime:web-runtime'
      }
    ]
    store.projectGroups = [{ id: 'group-1' }]
    store.allWorktrees.mockReturnValue([
      { id: 'folder:folder-1', repoId: 'folder:folder-1', path: '/repo/projects' }
    ])
    const { launchAgentInNewTabWithWorkspaceLauncher } =
      await import('./launch-agent-with-workspace-launcher')

    await launchAgentInNewTabWithWorkspaceLauncher({
      agent: 'claude',
      worktreeId: 'folder:folder-1'
    })

    expect(mockCallRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'web-runtime' },
      'files.resolveWorkspaceAgentLauncher',
      { worktree: 'id:folder:folder-1', platform: 'linux' },
      { timeoutMs: 10_000 }
    )
    expect(mockLaunchAgentInWebHostTab).toHaveBeenCalledWith(
      expect.objectContaining({
        startupPlan: expect.objectContaining({
          launchCommand: expect.stringContaining("'/repo/scripts/start-orca-agent'")
        })
      })
    )
  })

  it('queues the original cwd before a local Agent session starts', async () => {
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      initialCwd: '/repo/worktree/packages/app'
    })

    expect(mockQueueTabInitialCwd).toHaveBeenCalledWith('tab-1', '/repo/worktree/packages/app')
  })

  it('forwards the original cwd to a paired web runtime', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      groupId: 'group-1',
      initialCwd: '/repo/worktree/packages/app'
    })

    expect(mockLaunchAgentInWebHostTab).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-1',
        environmentId: 'web-runtime',
        groupId: 'group-1',
        cwd: '/repo/worktree/packages/app'
      })
    )
    expect(store.createTab).not.toHaveBeenCalled()
  })

  it('delivers submit-after-ready prompts on the paired host instead of creating a local tab', async () => {
    mockIsWebRuntimeSessionActive.mockReturnValue(true)
    const { launchAgentInNewTab } = await import('./launch-agent-in-new-tab')

    const result = launchAgentInNewTab({
      agent: 'claude',
      worktreeId: 'wt-1',
      prompt: 'continue the unfinished task',
      promptDelivery: 'submit-after-ready'
    })

    expect(mockLaunchAgentInWebHostTab).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'wt-1',
        environmentId: 'web-runtime',
        prompt: 'continue the unfinished task',
        promptDelivery: 'submit-after-ready',
        pastePromptAfterReady: 'continue the unfinished task',
        submitPastedPrompt: true
      })
    )
    expect(store.createTab).not.toHaveBeenCalled()
    await expect(result?.promptDeliveryResult).resolves.toEqual({
      delivered: true,
      failureNotified: false
    })
  })
})
