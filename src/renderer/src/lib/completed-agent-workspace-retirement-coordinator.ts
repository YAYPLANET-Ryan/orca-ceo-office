import type { AppState } from '@/store/types'
import { useAppStore } from '@/store'
import { getConnectionIdFromState } from './connection-owner-resolution'
import { getSettingsForWorktreeRuntimeOwner } from './worktree-runtime-owner'
import {
  fetchRuntimeGit,
  getRuntimeGitStatus,
  getRuntimeGitUpstreamStatus
} from '@/runtime/runtime-git-client'
import { getAllDrivers } from './pane-manager/mobile-driver-state'
import {
  getForegroundTerminalTabIds,
  getForegroundTerminalTabLastSeenAtById
} from './foreground-terminal-tabs'
import { getAgentHibernationOutputSignature } from './agent-hibernation-output-activity'
import { mergePendingTerminalInputActivity } from './terminal-input-activity-coalescing'
import {
  isCompletedAgentWorkspaceGitReady,
  planCompletedAgentWorkspaceRetirements,
  type CompletedAgentWorkspaceRetirementCandidate,
  type CompletedAgentWorkspaceRetirementSnapshot
} from './completed-agent-workspace-retirement-planner'
import {
  collectCompletedAgentWorkspaceRuntimePtyLiveness,
  type CompletedAgentWorkspaceRuntimePtyLiveness
} from './completed-agent-workspace-runtime-liveness'

export const COMPLETED_AGENT_WORKSPACE_RETIREMENT_TICK_MS = 60 * 1000

type IntervalHandle = ReturnType<typeof setInterval>

type CoordinatorOptions = {
  intervalMs?: number
  now?: () => number
}

const coordinator = {
  interval: null as IntervalHandle | null,
  confirmationState: {} as Record<string, string>,
  tickInFlight: false,
  retiringWorktreeIds: new Set<string>(),
  pendingArchiveWorktreeIds: new Set<string>(),
  now: () => Date.now()
}

function countByWorktreeId(values: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const worktreeId of values) {
    counts[worktreeId] = (counts[worktreeId] ?? 0) + 1
  }
  return counts
}

function snapshotFromState(
  state: AppState,
  now: number,
  runtimeLiveness: CompletedAgentWorkspaceRuntimePtyLiveness
): CompletedAgentWorkspaceRetirementSnapshot {
  return {
    settings: state.settings,
    worktrees: Object.values(state.worktreesByRepo).flat(),
    activeWorktreeId: state.activeWorktreeId,
    foregroundTerminalTabIds: getForegroundTerminalTabIds(),
    tabsByWorktree: state.tabsByWorktree,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    runtimeLivePtyIdsByWorktreeId: runtimeLiveness.runtimeLivePtyIdsByWorktreeId,
    runtimeLivenessRequiredWorktreeIds: runtimeLiveness.runtimeLivenessRequiredWorktreeIds,
    mobileLockedPtyIds: [...getAllDrivers()]
      .filter(([, driver]) => driver.kind === 'mobile')
      .map(([ptyId]) => ptyId),
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    lastTerminalInputAtByPaneKey: mergePendingTerminalInputActivity(
      state.lastTerminalInputAtByPaneKey
    ),
    foregroundTerminalLastSeenAtByTabId: getForegroundTerminalTabLastSeenAtById(),
    openFileCountByWorktreeId: countByWorktreeId(state.openFiles.map((file) => file.worktreeId)),
    browserTabCountByWorktreeId: Object.fromEntries(
      Object.entries(state.browserTabsByWorktree).map(([worktreeId, tabs]) => [
        worktreeId,
        tabs.length
      ])
    ),
    now
  }
}

async function currentCandidates(
  now: number
): Promise<CompletedAgentWorkspaceRetirementCandidate[]> {
  const runtimeLiveness = await collectCompletedAgentWorkspaceRuntimePtyLiveness(
    useAppStore.getState()
  )
  return planCompletedAgentWorkspaceRetirements(
    snapshotFromState(useAppStore.getState(), now, runtimeLiveness)
  ).map((candidate) => ({
    ...candidate,
    signature: `${candidate.signature}|output:${getAgentHibernationOutputSignature(candidate.paneKeys)}`
  }))
}

async function archiveCompletedWorkspace(worktreeId: string): Promise<boolean> {
  const result = await useAppStore.getState().updateWorktreeMeta(worktreeId, {
    workspaceStatus: 'completed',
    isArchived: true,
    isUnread: false
  })
  return result.ok
}

async function hasNoLocalWorkspaceProcesses(
  candidate: CompletedAgentWorkspaceRetirementCandidate,
  connectionId: string | null
): Promise<boolean> {
  if (!candidate.requiresLocalProcessProbe) {
    return true
  }
  const result = await window.api.workspaceCleanup.hasKillableLocalProcesses({
    worktreeId: candidate.worktreeId,
    connectionId,
    worktreePath: candidate.worktreePath
  })
  return result.hasKillableProcesses === false
}

async function retryPendingArchives(): Promise<void> {
  for (const worktreeId of coordinator.pendingArchiveWorktreeIds) {
    const state = useAppStore.getState()
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((candidate) => candidate.id === worktreeId)
    const tabs = state.tabsByWorktree[worktreeId] ?? []
    const userResumedWorkspace =
      state.activeWorktreeId === worktreeId ||
      tabs.some((tab) => (state.ptyIdsByTabId[tab.id] ?? []).length > 0) ||
      state.openFiles.some((file) => file.worktreeId === worktreeId) ||
      (state.browserTabsByWorktree[worktreeId] ?? []).length > 0
    if (!worktree || worktree.isArchived || userResumedWorkspace) {
      coordinator.pendingArchiveWorktreeIds.delete(worktreeId)
      continue
    }
    if (await archiveCompletedWorkspace(worktreeId)) {
      coordinator.pendingArchiveWorktreeIds.delete(worktreeId)
    }
  }
}

async function retireIfStillEligible(
  candidate: CompletedAgentWorkspaceRetirementCandidate,
  now: number
): Promise<void> {
  if (coordinator.retiringWorktreeIds.has(candidate.worktreeId)) {
    return
  }
  coordinator.retiringWorktreeIds.add(candidate.worktreeId)
  try {
    const state = useAppStore.getState()
    const connectionId = getConnectionIdFromState(state, candidate.worktreeId)
    if (connectionId === undefined) {
      return
    }
    if (!(await hasNoLocalWorkspaceProcesses(candidate, connectionId))) {
      return
    }
    const context = {
      settings: getSettingsForWorktreeRuntimeOwner(state, candidate.worktreeId),
      worktreeId: candidate.worktreeId,
      worktreePath: candidate.worktreePath,
      connectionId: connectionId ?? undefined
    }
    const status = await getRuntimeGitStatus(context, {
      bypassEffectiveUpstreamNegativeCache: true,
      reuseLineStats: true
    })
    if (
      status.didHitLimit === true ||
      status.entries.length > 0 ||
      status.head !== candidate.expectedHead
    ) {
      return
    }
    await fetchRuntimeGit(context, candidate.pushTarget)
    const upstream = await getRuntimeGitUpstreamStatus(context, candidate.pushTarget)
    if (!isCompletedAgentWorkspaceGitReady(status, upstream, candidate.expectedHead)) {
      return
    }

    const stillEligible = (await currentCandidates(now)).some(
      (current) => current.id === candidate.id && current.signature === candidate.signature
    )
    if (!stillEligible) {
      return
    }

    const finalStatus = await getRuntimeGitStatus(context, {
      bypassEffectiveUpstreamNegativeCache: true,
      reuseLineStats: true
    })
    const finalUpstream = await getRuntimeGitUpstreamStatus(context, candidate.pushTarget)
    if (!isCompletedAgentWorkspaceGitReady(finalStatus, finalUpstream, candidate.expectedHead)) {
      return
    }
    if (!(await hasNoLocalWorkspaceProcesses(candidate, connectionId))) {
      return
    }

    const completed = await useAppStore
      .getState()
      .updateWorktreeMeta(candidate.worktreeId, { workspaceStatus: 'completed' })
    if (!completed.ok) {
      return
    }
    if (candidate.mode === 'live-agent') {
      await useAppStore.getState().shutdownWorktreeTerminals(candidate.worktreeId, {
        keepIdentifiers: true,
        shutdownReason: 'auto-hibernate-completed-agent',
        sleepingPaneKeys: candidate.paneKeys,
        ...(candidate.expectedRuntimePtyIds.length > 0
          ? { expectedRuntimePtyIds: candidate.expectedRuntimePtyIds }
          : {})
      })
    }
    if (!(await archiveCompletedWorkspace(candidate.worktreeId))) {
      coordinator.pendingArchiveWorktreeIds.add(candidate.worktreeId)
    }
  } catch (error) {
    console.warn(
      '[completed-agent-workspace-retirement] safe retirement deferred:',
      candidate.worktreeId,
      error
    )
  } finally {
    coordinator.retiringWorktreeIds.delete(candidate.worktreeId)
  }
}

export async function runCompletedAgentWorkspaceRetirementTick(
  options: Pick<CoordinatorOptions, 'now'> = {}
): Promise<void> {
  if (coordinator.tickInFlight) {
    return
  }
  coordinator.tickInFlight = true
  try {
    await retryPendingArchives()
    const now = (options.now ?? coordinator.now)()
    const candidates = await currentCandidates(now)
    const nextConfirmationState: Record<string, string> = {}
    const confirmed: CompletedAgentWorkspaceRetirementCandidate[] = []
    for (const candidate of candidates) {
      nextConfirmationState[candidate.id] = candidate.signature
      if (coordinator.confirmationState[candidate.id] === candidate.signature) {
        confirmed.push(candidate)
      }
    }
    coordinator.confirmationState = nextConfirmationState
    await Promise.all(confirmed.map((candidate) => retireIfStillEligible(candidate, now)))
  } finally {
    coordinator.tickInFlight = false
  }
}

export function startCompletedAgentWorkspaceRetirementCoordinator(
  options: CoordinatorOptions = {}
): () => void {
  if (coordinator.interval !== null) {
    return stopCompletedAgentWorkspaceRetirementCoordinator
  }
  coordinator.now = options.now ?? (() => Date.now())
  coordinator.interval = setInterval(
    () => void runCompletedAgentWorkspaceRetirementTick(),
    options.intervalMs ?? COMPLETED_AGENT_WORKSPACE_RETIREMENT_TICK_MS
  )
  return stopCompletedAgentWorkspaceRetirementCoordinator
}

export function stopCompletedAgentWorkspaceRetirementCoordinator(): void {
  if (coordinator.interval !== null) {
    clearInterval(coordinator.interval)
    coordinator.interval = null
  }
  coordinator.confirmationState = {}
  coordinator.pendingArchiveWorktreeIds.clear()
}

export function resetCompletedAgentWorkspaceRetirementCoordinatorForTests(): void {
  stopCompletedAgentWorkspaceRetirementCoordinator()
  coordinator.tickInFlight = false
  coordinator.retiringWorktreeIds.clear()
  coordinator.pendingArchiveWorktreeIds.clear()
  coordinator.now = () => Date.now()
}
