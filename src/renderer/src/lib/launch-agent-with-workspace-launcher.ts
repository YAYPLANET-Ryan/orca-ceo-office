import { useAppStore } from '@/store'
import { resolveAgentBackgroundLaunchHost } from '@/lib/agent-background-session-launch-host'
import {
  launchAgentInNewTab,
  type LaunchAgentInNewTabArgs,
  type LaunchAgentInNewTabResult
} from '@/lib/launch-agent-in-new-tab'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { confirmWorkspaceAgentLauncher } from '@/lib/ensure-hooks-confirmed'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId
} from '../../../shared/execution-host'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { resolveStartupShell } from '../../../shared/tui-agent-startup-shell'
import {
  buildWorkspaceAgentLauncherCommand,
  isWorkspaceContractAgent,
  type WorkspaceAgentLauncherResolution
} from '../../../shared/workspace-agent-launcher-contract'

export function isWorkspaceAgentLauncherTrusted(args: {
  store: ReturnType<typeof useAppStore.getState>
  repo: ReturnType<typeof useAppStore.getState>['repos'][number] | null
  workspaceRoot: string
  connectionId: string | null
  runtimeEnvironmentId: string | null
}): boolean {
  const repo = findWorkspaceAgentLauncherTrustRepo(args)
  return Boolean(repo && args.store.trustedOrcaHooks?.[repo.id]?.all)
}

export function findWorkspaceAgentLauncherTrustRepo(args: {
  store: ReturnType<typeof useAppStore.getState>
  repo: ReturnType<typeof useAppStore.getState>['repos'][number] | null
  workspaceRoot: string
  connectionId: string | null
  runtimeEnvironmentId: string | null
}): ReturnType<typeof useAppStore.getState>['repos'][number] | null {
  const candidates = (
    args.store.repos?.length ? args.store.repos : args.repo ? [args.repo] : []
  ).filter(
    (repo) =>
      normalizeRuntimePathForComparison(repo.path) ===
      normalizeRuntimePathForComparison(args.workspaceRoot)
  )
  const hostCandidates = candidates.filter((repo) => {
    if (args.connectionId) {
      return repo.connectionId === args.connectionId
    }
    if (args.runtimeEnvironmentId) {
      const host = parseExecutionHostId(getRepoExecutionHostId(repo))
      return host?.kind === 'runtime' && host.environmentId === args.runtimeEnvironmentId
    }
    return getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
  })
  const repoIds = new Set(hostCandidates.map((repo) => repo.id))
  if (hostCandidates.length !== 1 || repoIds.size !== 1) {
    return null
  }
  return hostCandidates[0]
}

/** Resolves a repository-owned launcher before creating the tab, then falls back to the normal command. */
export async function launchAgentInNewTabWithWorkspaceLauncher(
  args: LaunchAgentInNewTabArgs
): Promise<LaunchAgentInNewTabResult> {
  if (!isWorkspaceContractAgent(args.agent)) {
    return launchAgentInNewTab(args)
  }

  const store = useAppStore.getState()
  const worktree = store
    .allWorktrees?.()
    .find((entry: { id: string }) => entry.id === args.worktreeId)
  if (!worktree?.path) {
    return launchAgentInNewTab(args)
  }
  const repo = store.repos?.find((entry) => entry.id === worktree.repoId) ?? null
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(store, args.worktreeId)
  const pairedRuntimeEnvironmentId =
    runtimeEnvironmentId && isWebRuntimeSessionActive(runtimeEnvironmentId)
      ? runtimeEnvironmentId
      : null
  let host
  try {
    host = resolveAgentBackgroundLaunchHost({
      store,
      worktreeId: args.worktreeId,
      worktreePath: worktree.path,
      repo
    })
  } catch {
    return launchAgentInNewTab(args)
  }
  const launchPlatform = pairedRuntimeEnvironmentId
    ? isWindowsAbsolutePathLike(worktree.path)
      ? 'win32'
      : 'linux'
    : host.platform

  let resolution: WorkspaceAgentLauncherResolution | null = null
  try {
    resolution = pairedRuntimeEnvironmentId
      ? await callRuntimeRpc<WorkspaceAgentLauncherResolution | null>(
          { kind: 'environment', environmentId: pairedRuntimeEnvironmentId },
          'files.resolveWorkspaceAgentLauncher',
          { worktree: toRuntimeWorktreeSelector(args.worktreeId), platform: launchPlatform },
          { timeoutMs: 10_000 }
        )
      : await window.api.fs.resolveWorkspaceAgentLauncher({
          workspacePath: worktree.path,
          ...(host.connectionId ? { connectionId: host.connectionId } : {}),
          platform: launchPlatform
        })
  } catch (error) {
    console.warn('Workspace agent launcher resolution failed; using the default command.', error)
  }

  if (!resolution) {
    return launchAgentInNewTab({ ...args, launchPlatform })
  }
  const trustArgs = {
    store,
    repo,
    workspaceRoot: resolution.workspaceRoot,
    connectionId: host.connectionId,
    runtimeEnvironmentId: pairedRuntimeEnvironmentId
  }
  const trustRepo = findWorkspaceAgentLauncherTrustRepo(trustArgs)
  if (!trustRepo) {
    return launchAgentInNewTab({ ...args, launchPlatform })
  }
  if (!isWorkspaceAgentLauncherTrusted(trustArgs)) {
    const decision = await confirmWorkspaceAgentLauncher(
      store,
      trustRepo.id,
      trustRepo.displayName,
      resolution.launcherPath
    )
    if (decision !== 'run') {
      return launchAgentInNewTab({ ...args, launchPlatform })
    }
  }
  const queuedShell = resolveStartupShell(
    launchPlatform,
    resolveLocalWindowsAgentStartupShell({
      platform: launchPlatform,
      isRemote: host.isRemote || Boolean(pairedRuntimeEnvironmentId),
      terminalWindowsShell: store.settings?.terminalWindowsShell
    })
  )
  return launchAgentInNewTab({
    ...args,
    launchPlatform,
    agentCommandOverride: buildWorkspaceAgentLauncherCommand({
      launcherPath: resolution.launcherPath,
      agent: args.agent,
      platform: launchPlatform,
      shell: queuedShell
    })
  })
}
