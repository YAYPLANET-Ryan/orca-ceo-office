import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { getAgentResumeArgv } from '../../../shared/agent-session-resume'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type {
  GitStatusResult,
  GitUpstreamStatus,
  GlobalSettings,
  TerminalLayoutSnapshot,
  TerminalTab,
  Worktree
} from '../../../shared/types'
import { parseRemoteRuntimePtyId } from '@/runtime/runtime-terminal-stream'
import { getEffectiveAgentHibernationIdleMs } from './agent-hibernation-planner'
import { lastInputBlocksHibernation } from './agent-hibernation-input-guard'

type RetirementSettings = Pick<
  GlobalSettings,
  'autoArchiveCompletedAgentWorkspaces' | 'agentHibernationIdleMs'
>

export type CompletedAgentWorkspaceRetirementSnapshot = {
  settings: RetirementSettings | null
  worktrees: Worktree[]
  activeWorktreeId: string | null
  foregroundTerminalTabIds: string[]
  tabsByWorktree: Record<string, TerminalTab[]>
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot | undefined>
  ptyIdsByTabId: Record<string, string[] | undefined>
  runtimeLivePtyIdsByWorktreeId: Record<string, string[] | undefined>
  runtimeLivenessRequiredWorktreeIds: string[]
  mobileLockedPtyIds: string[]
  agentStatusByPaneKey: Record<string, AgentStatusEntry | undefined>
  lastTerminalInputAtByPaneKey: Record<string, number | undefined>
  foregroundTerminalLastSeenAtByTabId: Record<string, number | undefined>
  openFileCountByWorktreeId: Record<string, number | undefined>
  browserTabCountByWorktreeId: Record<string, number | undefined>
  now: number
}

export type CompletedAgentWorkspaceRetirementCandidate = {
  id: string
  worktreeId: string
  worktreePath: string
  pushTarget: Worktree['pushTarget']
  mode: 'live-agent' | 'dormant-workspace'
  requiresLocalProcessProbe: boolean
  paneKeys: string[]
  targetPtyIds: string[]
  expectedRuntimePtyIds: string[]
  expectedHead: string
  signature: string
}

const SUPPORTED_LAUNCH_AGENTS = new Set(['claude', 'claude-agent-teams', 'codex'])

function isSupportedAgentType(value: AgentStatusEntry['agentType']): value is 'claude' | 'codex' {
  return value === 'claude' || value === 'codex'
}

function toRuntimePtyId(ptyId: string): string {
  return parseRemoteRuntimePtyId(ptyId)?.handle ?? ptyId
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

function isSettledOrchestration(entry: AgentStatusEntry): boolean {
  return entry.orchestration
    ? ['completed', 'failed', 'circuit_broken'].includes(entry.orchestration.dispatchStatus ?? '')
    : true
}

function hasCompletedWorkEvidence(entry: AgentStatusEntry): boolean {
  return (
    entry.prompt.trim().length > 0 ||
    entry.stateHistory.some((history) => history.state === 'working')
  )
}

function isSupportedCompletedEntry(
  entry: AgentStatusEntry,
  now: number,
  idleMs: number,
  inputAt: number | undefined,
  foregroundLastSeenAt: number | undefined
): boolean {
  const effectiveIdleStart = Math.max(
    entry.updatedAt,
    typeof foregroundLastSeenAt === 'number' && Number.isFinite(foregroundLastSeenAt)
      ? foregroundLastSeenAt
      : 0
  )
  if (
    entry.state !== 'done' ||
    entry.interrupted === true ||
    Boolean(entry.subagents?.length) ||
    !isSettledOrchestration(entry) ||
    !isSupportedAgentType(entry.agentType) ||
    !entry.providerSession ||
    !hasCompletedWorkEvidence(entry) ||
    now - effectiveIdleStart < idleMs ||
    (typeof inputAt === 'number' &&
      Number.isFinite(inputAt) &&
      lastInputBlocksHibernation(entry, inputAt))
  ) {
    return false
  }
  return getAgentResumeArgv(entry.agentType, entry.providerSession) !== null
}

function isAgentCreatedWorkspace(worktree: Worktree, tabs: TerminalTab[]): boolean {
  if (typeof worktree.createdAt !== 'number' || !Number.isFinite(worktree.createdAt)) {
    return false
  }
  return (
    (worktree.createdWithAgent !== undefined &&
      SUPPORTED_LAUNCH_AGENTS.has(worktree.createdWithAgent)) ||
    (worktree.cliProvenance?.startupAgent !== undefined &&
      SUPPORTED_LAUNCH_AGENTS.has(worktree.cliProvenance.startupAgent)) ||
    Boolean(worktree.cliProvenance?.callerTerminalHandle) ||
    worktree.automationProvenance?.kind === 'created-by-automation' ||
    tabs.some(
      (tab) => tab.launchAgent !== undefined && SUPPORTED_LAUNCH_AGENTS.has(tab.launchAgent)
    )
  )
}

function hasSupportedAgentProvenance(worktree: Worktree, tabs: TerminalTab[]): boolean {
  return (
    (worktree.createdWithAgent !== undefined &&
      SUPPORTED_LAUNCH_AGENTS.has(worktree.createdWithAgent)) ||
    (worktree.cliProvenance?.startupAgent !== undefined &&
      SUPPORTED_LAUNCH_AGENTS.has(worktree.cliProvenance.startupAgent)) ||
    tabs.some(
      (tab) => tab.launchAgent !== undefined && SUPPORTED_LAUNCH_AGENTS.has(tab.launchAgent)
    )
  )
}

function entryTabId(entry: AgentStatusEntry): string | null {
  return entry.tabId ?? parsePaneKey(entry.paneKey)?.tabId ?? null
}

function signatureFor(
  worktree: Worktree,
  paneEntries: { entry: AgentStatusEntry; ptyId: string; runtimePtyId: string }[]
): string {
  const panes = paneEntries
    .slice()
    .sort((a, b) => a.entry.paneKey.localeCompare(b.entry.paneKey))
    .map(
      ({ entry, ptyId, runtimePtyId }) =>
        `${entry.paneKey}:${ptyId}:${runtimePtyId}:${entry.agentType}:${entry.providerSession?.id}:${entry.updatedAt}`
    )
  return `${worktree.id}|${worktree.head}|${worktree.branch}|${panes.join('|')}`
}

function dormantSignatureFor(worktree: Worktree, tabs: TerminalTab[]): string {
  const provenance = [
    worktree.createdWithAgent ?? '',
    worktree.cliProvenance?.startupAgent ?? '',
    ...tabs
      .map((tab) => `${tab.id}:${tab.launchAgent ?? ''}:${tab.ptyId ?? ''}`)
      .sort((a, b) => a.localeCompare(b))
  ]
  return `${worktree.id}|${worktree.head}|${worktree.branch}|${worktree.lastActivityAt}|dormant|${provenance.join('|')}`
}

export function planCompletedAgentWorkspaceRetirements(
  snapshot: CompletedAgentWorkspaceRetirementSnapshot
): CompletedAgentWorkspaceRetirementCandidate[] {
  if (snapshot.settings?.autoArchiveCompletedAgentWorkspaces !== true) {
    return []
  }
  const idleMs = getEffectiveAgentHibernationIdleMs(snapshot.settings.agentHibernationIdleMs)
  const foregroundTabs = new Set(snapshot.foregroundTerminalTabIds)
  const runtimeRequired = new Set(snapshot.runtimeLivenessRequiredWorktreeIds)
  const mobileLocked = new Set(snapshot.mobileLockedPtyIds.map(toRuntimePtyId))
  const candidates: CompletedAgentWorkspaceRetirementCandidate[] = []
  const worktreeIdCounts = new Map<string, number>()
  for (const worktree of snapshot.worktrees) {
    worktreeIdCounts.set(worktree.id, (worktreeIdCounts.get(worktree.id) ?? 0) + 1)
  }

  for (const worktree of snapshot.worktrees) {
    const tabs = snapshot.tabsByWorktree[worktree.id] ?? []
    if (
      worktree.id === snapshot.activeWorktreeId ||
      worktree.isMainWorktree ||
      worktree.isBare ||
      worktree.isArchived ||
      worktree.isPinned ||
      worktreeIdCounts.get(worktree.id) !== 1 ||
      tabs.some((tab) => tab.isPinned || foregroundTabs.has(tab.id)) ||
      !isAgentCreatedWorkspace(worktree, tabs) ||
      (snapshot.openFileCountByWorktreeId[worktree.id] ?? 0) > 0 ||
      (snapshot.browserTabCountByWorktreeId[worktree.id] ?? 0) > 0
    ) {
      continue
    }

    const requiresRuntimeLiveness = runtimeRequired.has(worktree.id)
    if (
      requiresRuntimeLiveness &&
      !Object.prototype.hasOwnProperty.call(snapshot.runtimeLivePtyIdsByWorktreeId, worktree.id)
    ) {
      continue
    }
    const liveRuntimePtyIds = sortedUnique(
      (requiresRuntimeLiveness
        ? (snapshot.runtimeLivePtyIdsByWorktreeId[worktree.id] ?? [])
        : tabs.flatMap((tab) => snapshot.ptyIdsByTabId[tab.id] ?? [])
      ).map(toRuntimePtyId)
    )
    if (liveRuntimePtyIds.some((ptyId) => mobileLocked.has(ptyId))) {
      continue
    }

    if (liveRuntimePtyIds.length === 0) {
      const mostRecentVisibleActivity = Math.max(
        worktree.lastActivityAt,
        worktree.createdAt ?? 0,
        ...tabs.map((tab) => snapshot.foregroundTerminalLastSeenAtByTabId[tab.id] ?? 0)
      )
      if (
        !hasSupportedAgentProvenance(worktree, tabs) ||
        snapshot.now - mostRecentVisibleActivity < idleMs
      ) {
        continue
      }
      candidates.push({
        id: worktree.id,
        worktreeId: worktree.id,
        worktreePath: worktree.path,
        pushTarget: worktree.pushTarget,
        mode: 'dormant-workspace',
        requiresLocalProcessProbe: !requiresRuntimeLiveness,
        paneKeys: [],
        targetPtyIds: [],
        expectedRuntimePtyIds: [],
        expectedHead: worktree.head,
        signature: dormantSignatureFor(worktree, tabs)
      })
      continue
    }

    const tabIds = new Set(tabs.map((tab) => tab.id))
    const paneEntries: { entry: AgentStatusEntry; ptyId: string; runtimePtyId: string }[] = []
    for (const entry of Object.values(snapshot.agentStatusByPaneKey)) {
      if (!entry || !tabIds.has(entryTabId(entry) ?? '')) {
        continue
      }
      const parsed = parsePaneKey(entry.paneKey)
      const tabId = entryTabId(entry)
      if (
        !parsed ||
        !tabId ||
        parsed.tabId !== tabId ||
        !isSupportedCompletedEntry(
          entry,
          snapshot.now,
          idleMs,
          snapshot.lastTerminalInputAtByPaneKey[entry.paneKey],
          snapshot.foregroundTerminalLastSeenAtByTabId[tabId]
        )
      ) {
        continue
      }
      const ptyId = snapshot.terminalLayoutsByTabId[tabId]?.ptyIdsByLeafId?.[parsed.leafId]
      if (!ptyId) {
        continue
      }
      const runtimePtyId = toRuntimePtyId(ptyId)
      if (liveRuntimePtyIds.includes(runtimePtyId)) {
        paneEntries.push({ entry, ptyId, runtimePtyId })
      }
    }

    const coveredRuntimePtyIds = sortedUnique(paneEntries.map((pane) => pane.runtimePtyId))
    if (
      paneEntries.length === 0 ||
      coveredRuntimePtyIds.length !== liveRuntimePtyIds.length ||
      coveredRuntimePtyIds.some((ptyId, index) => ptyId !== liveRuntimePtyIds[index])
    ) {
      continue
    }

    candidates.push({
      id: worktree.id,
      worktreeId: worktree.id,
      worktreePath: worktree.path,
      pushTarget: worktree.pushTarget,
      mode: 'live-agent',
      requiresLocalProcessProbe: false,
      paneKeys: paneEntries.map((pane) => pane.entry.paneKey).sort(),
      targetPtyIds: sortedUnique(paneEntries.map((pane) => pane.ptyId)),
      expectedRuntimePtyIds: requiresRuntimeLiveness ? liveRuntimePtyIds : [],
      expectedHead: worktree.head,
      signature: signatureFor(worktree, paneEntries)
    })
  }

  return candidates.sort((a, b) => a.worktreeId.localeCompare(b.worktreeId))
}

export function isCompletedAgentWorkspaceGitReady(
  status: GitStatusResult,
  upstream: GitUpstreamStatus,
  expectedHead: string
): boolean {
  return (
    status.didHitLimit !== true &&
    status.entries.length === 0 &&
    status.head === expectedHead &&
    upstream.hasUpstream === true &&
    upstream.ahead === 0
  )
}
