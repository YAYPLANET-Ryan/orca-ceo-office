import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { TuiAgent } from '../../../../shared/tui-agent'

export type PaneForegroundAgentEntry = {
  /** Recognized agent process in the pane's foreground; null when unknown. */
  agent: TuiAgent | null
  /** True only when fresh provider evidence is safe for input-byte routing. */
  routingTrusted?: boolean
  /** True after exit/input evidence revokes routing until provider confirmation. */
  routingRevoked?: boolean
  /** True while previously trusted routing awaits provider revalidation. Retains
   *  Shift+Enter byte capability only — the Ctrl+Enter resolver deliberately does
   *  not read it, because its fallback is a plain CR that submits either way. */
  routingConfirmationPending?: boolean
  /** True once the foreground is proven back at the shell (OSC 133;D) —
   *  process-grade launched-agent exit evidence, independent of titles. */
  shellForeground: boolean
}

/**
 * Process-table identity for local panes, read at OSC 133 command boundaries
 * (see pane-foreground-agent-tracker). Sits below hook rows in the tab-icon
 * resolution; covers agents that emit neither hooks nor titles.
 */
export type PaneForegroundAgentSlice = {
  paneForegroundAgentByPaneKey: Record<string, PaneForegroundAgentEntry>
  setPaneForegroundAgent: (
    paneKey: string,
    entry: PaneForegroundAgentEntry,
    options?: { observedAt?: number }
  ) => void
  clearPaneForegroundAgent: (paneKey: string) => void
  /** Wholesale teardown sweeps (tab close, worktree sleep/remove) retire pane
   *  keys without per-pane close events — clear their entries too. */
  clearPaneForegroundAgentByTabPrefix: (tabIdPrefix: string) => void
  clearPaneForegroundAgentByWorktree: (worktreeId: string) => void
}

// Why: the identity resolver fences a shell-return observation against the
// row's last hook (agent-status-identity.ts). The stamp lives beside the entry,
// not in it, so a value-equal republish keeps the store reference stable.
const observedAtByPaneKey = new Map<string, number>()

export function getPaneForegroundObservedAt(paneKey: string): number | undefined {
  return observedAtByPaneKey.get(paneKey)
}

/** Pane-key moves (transferAgentPaneAuthority) carry the observation with the entry. */
export function rebindPaneForegroundObservation(from: string, to: string): void {
  const observedAt = observedAtByPaneKey.get(from)
  observedAtByPaneKey.delete(from)
  if (observedAt !== undefined) {
    observedAtByPaneKey.set(to, observedAt)
  }
}

// Why: main's hook server resolves nested-hook identity with the same evidence the
// renderer holds; without this report the two sides disagree on which agent and
// which provider session a pane keeps when a child CLI posts hooks from inside it.
// Every store mutation of an entry — set, clear, bulk sweep, pane-key move — reports.
export function reportPaneForegroundToMain(
  paneKey: string,
  entry: PaneForegroundAgentEntry | null
): void {
  try {
    const report = globalThis.window?.api?.agentHooks?.reportPaneForeground
    const observedAt = observedAtByPaneKey.get(paneKey)
    report?.(
      paneKey,
      entry
        ? {
            agent: entry.agent,
            shellForeground: entry.shellForeground,
            ...(entry.routingRevoked ? { routingRevoked: true } : {}),
            ...(observedAt !== undefined ? { observedAt } : {})
          }
        : null
    )
  } catch {
    // Why: the report is advisory; a missing preload bridge (tests, web client) must not break the slice.
  }
}

function forgetPaneForeground(paneKeys: readonly string[]): void {
  for (const paneKey of paneKeys) {
    observedAtByPaneKey.delete(paneKey)
    reportPaneForegroundToMain(paneKey, null)
  }
}

export const createPaneForegroundAgentSlice: StateCreator<
  AppState,
  [],
  [],
  PaneForegroundAgentSlice
> = (set) => ({
  paneForegroundAgentByPaneKey: {},
  setPaneForegroundAgent: (paneKey, entry, options) => {
    let changed = false
    set((s) => {
      const current = s.paneForegroundAgentByPaneKey[paneKey]
      if (
        current &&
        current.agent === entry.agent &&
        current.routingTrusted === entry.routingTrusted &&
        current.routingRevoked === entry.routingRevoked &&
        current.routingConfirmationPending === entry.routingConfirmationPending &&
        current.shellForeground === entry.shellForeground
      ) {
        return s
      }
      changed = true
      return {
        paneForegroundAgentByPaneKey: { ...s.paneForegroundAgentByPaneKey, [paneKey]: entry }
      }
    })
    if (changed) {
      observedAtByPaneKey.set(paneKey, options?.observedAt ?? Date.now())
      reportPaneForegroundToMain(paneKey, entry)
    }
  },
  clearPaneForegroundAgent: (paneKey) => {
    let changed = false
    set((s) => {
      if (!(paneKey in s.paneForegroundAgentByPaneKey)) {
        return s
      }
      changed = true
      const next = { ...s.paneForegroundAgentByPaneKey }
      delete next[paneKey]
      return { paneForegroundAgentByPaneKey: next }
    })
    if (changed) {
      forgetPaneForeground([paneKey])
    }
  },
  clearPaneForegroundAgentByTabPrefix: (tabIdPrefix) => {
    let staleKeys: string[] = []
    set((s) => {
      staleKeys = collectPaneForegroundAgentKeysByTabPrefix(s.paneForegroundAgentByPaneKey, [
        `${tabIdPrefix}:`
      ])
      return (
        buildPaneForegroundAgentTabPrefixClearPatch(s.paneForegroundAgentByPaneKey, [
          `${tabIdPrefix}:`
        ]) ?? s
      )
    })
    forgetPaneForeground(staleKeys)
  },
  clearPaneForegroundAgentByWorktree: (worktreeId) => {
    // Why: entries carry no worktreeId, so this must run while the worktree's
    // tabs are still in tabsByWorktree (removeWorktree prunes them only after
    // awaiting terminal teardown).
    let staleKeys: string[] = []
    set((s) => {
      const prefixes = (s.tabsByWorktree[worktreeId] ?? []).map((tab) => `${tab.id}:`)
      staleKeys = collectPaneForegroundAgentKeysByTabPrefix(
        s.paneForegroundAgentByPaneKey,
        prefixes
      )
      return (
        buildPaneForegroundAgentTabPrefixClearPatch(s.paneForegroundAgentByPaneKey, prefixes) ?? s
      )
    })
    forgetPaneForeground(staleKeys)
  }
})

export function collectPaneForegroundAgentKeysByTabPrefix(
  entries: Record<string, PaneForegroundAgentEntry>,
  tabPrefixes: readonly string[]
): string[] {
  if (tabPrefixes.length === 0) {
    return []
  }
  return Object.keys(entries).filter((paneKey) =>
    tabPrefixes.some((prefix) => paneKey.startsWith(prefix))
  )
}

export function buildPaneForegroundAgentTabPrefixClearPatch(
  entries: Record<string, PaneForegroundAgentEntry>,
  tabPrefixes: readonly string[]
): Pick<PaneForegroundAgentSlice, 'paneForegroundAgentByPaneKey'> | null {
  if (tabPrefixes.length === 0) {
    return null
  }
  const staleKeys = collectPaneForegroundAgentKeysByTabPrefix(entries, tabPrefixes)
  if (staleKeys.length === 0) {
    return null
  }
  const next = { ...entries }
  for (const paneKey of staleKeys) {
    delete next[paneKey]
  }
  return { paneForegroundAgentByPaneKey: next }
}
