import { replaceRecordEntries } from '@/store/keyed-record-transitions'
import { sleepingAgentRecordIndex } from '../../terminals/sleeping-agent-record-index'

import type { SleepingAgentSessionRecord } from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import type { AgentStatusRuntime } from './agent-status-runtime'
import type { AppState } from '../../types'
import { collectSleepingAgentSessionRecordsForWorktree } from './agent-status-recovery-collection'
import { removeSleepingRecordsReplacedByManualWorktreeSleep } from './agent-status-sleeping-records'
import {
  capturedResumeRecord,
  resumeRecordFromStatus
} from '../../../../../shared/agent-session/lifecycle/agent-resume-record-from-status'
import { getLaunchConfigForEntry } from './agent-status-launch-config'
import { findAgentPaneWorktreeId, findTabForAgentEntry } from './agent-status-pane-key-tab-binding'

export function createAgentStatusRecoveryActions(
  runtime: AgentStatusRuntime
): Pick<
  AgentStatusSlice,
  | 'captureSleepingAgentSessionsByWorktree'
  | 'captureAllSleepingAgentSessions'
  | 'clearSleepingAgentSession'
  | 'markSleepingAgentSessionExited'
  | 'rememberSleepingAgentSession'
  | 'clearSleepingAgentSessionsByPaneKey'
  | 'clearSleepingAgentSessionsByWorktree'
  | 'pruneSleepingAgentSessions'
> {
  const { set, clearSleepingAgentSessionsByPaneKey } = runtime
  return {
    captureSleepingAgentSessionsByWorktree: (worktreeId, paneKeys) => {
      set((s) => {
        const records = collectSleepingAgentSessionRecordsForWorktree(s, worktreeId, {
          paneKeys,
          captureMode: 'manual-worktree-sleep'
        })
        const replaced = removeSleepingRecordsReplacedByManualWorktreeSleep(
          s.sleepingAgentSessionsByPaneKey,
          worktreeId,
          paneKeys,
          records
        )
        const updates = new Map<string, SleepingAgentSessionRecord>()
        let changed = replaced.changed
        for (const record of Object.values(records)) {
          if ((updates.get(record.paneKey) ?? replaced.records[record.paneKey]) !== record) {
            updates.set(record.paneKey, record)
            changed = true
          }
        }
        return changed
          ? {
              sleepingAgentSessionsByPaneKey: replaceRecordEntries(replaced.records, updates)
            }
          : s
      })
    },

    captureAllSleepingAgentSessions: (mode) => {
      set((s) => {
        const capturedAt = Date.now()
        const updates = new Map<string, SleepingAgentSessionRecord>()
        let changed = false
        for (const entry of Object.values(s.agentStatusByPaneKey)) {
          const record = capturedResumeRecord({
            entry,
            existing: updates.get(entry.paneKey) ?? s.sleepingAgentSessionsByPaneKey[entry.paneKey],
            mode,
            capturedAt,
            worktreeIdOf: () => entry.worktreeId ?? findAgentPaneWorktreeId(s, entry.paneKey),
            tabOf: (worktreeId) => findTabForAgentEntry(s, worktreeId, entry),
            launchConfigOf: () => getLaunchConfigForEntry(s, entry)
          })
          if (record) {
            updates.set(record.paneKey, record)
            changed = true
          }
        }
        return changed
          ? {
              sleepingAgentSessionsByPaneKey: replaceRecordEntries(
                s.sleepingAgentSessionsByPaneKey,
                updates
              )
            }
          : s
      })
    },

    clearSleepingAgentSession: (paneKey) => clearSleepingAgentSessionsByPaneKey([paneKey]),

    markSleepingAgentSessionExited: (paneKey) => {
      set((s) => {
        // capturedAt becomes the exit time: only a status received after it lifts the fence.
        const exitedAt = Date.now()
        const record = s.sleepingAgentSessionsByPaneKey[paneKey] ?? exitedStatusRecord(s, paneKey)
        if (!record || record.requiresManualResume === true) {
          return s
        }
        return {
          sleepingAgentSessionsByPaneKey: {
            ...s.sleepingAgentSessionsByPaneKey,
            [paneKey]: {
              ...record,
              capturedAt: Math.max(record.capturedAt, exitedAt),
              requiresManualResume: true
            }
          }
        }
      })
    },

    rememberSleepingAgentSession: (record, replaces) => {
      set((s) =>
        s.sleepingAgentSessionsByPaneKey[record.paneKey] !== replaces
          ? s
          : {
              sleepingAgentSessionsByPaneKey: replaceRecordEntries(
                s.sleepingAgentSessionsByPaneKey,
                [[record.paneKey, record]]
              )
            }
      )
    },
    clearSleepingAgentSessionsByPaneKey,

    clearSleepingAgentSessionsByWorktree: (worktreeId) => {
      set((s) => {
        let changed = false
        const removed: string[] = []
        for (const [paneKey, record] of sleepingAgentRecordIndex.entries(
          s.sleepingAgentSessionsByPaneKey,
          worktreeId
        )) {
          if (record.worktreeId === worktreeId) {
            changed = true
            removed.push(paneKey)
          }
        }
        if (!changed) {
          return s
        }
        const nextLaunch =
          removed.length > 0 ? { ...s.agentLaunchConfigByPaneKey } : s.agentLaunchConfigByPaneKey
        for (const paneKey of removed) {
          delete nextLaunch[paneKey]
        }
        return {
          sleepingAgentSessionsByPaneKey: replaceRecordEntries<SleepingAgentSessionRecord>(
            s.sleepingAgentSessionsByPaneKey,
            removed.map((key) => [key, null] as const)
          ),
          ...(nextLaunch !== s.agentLaunchConfigByPaneKey
            ? { agentLaunchConfigByPaneKey: nextLaunch }
            : {})
        }
      })
    },

    pruneSleepingAgentSessions: (validWorktreeIds) => {
      set((s) => {
        let changed = false
        const removed: string[] = []
        for (const [paneKey, record] of Object.entries(s.sleepingAgentSessionsByPaneKey)) {
          if (!validWorktreeIds.has(record.worktreeId)) {
            changed = true
            removed.push(paneKey)
          }
        }
        if (!changed) {
          return s
        }
        const nextLaunch =
          removed.length > 0 ? { ...s.agentLaunchConfigByPaneKey } : s.agentLaunchConfigByPaneKey
        for (const paneKey of removed) {
          delete nextLaunch[paneKey]
        }
        return {
          sleepingAgentSessionsByPaneKey: replaceRecordEntries<SleepingAgentSessionRecord>(
            s.sleepingAgentSessionsByPaneKey,
            removed.map((key) => [key, null] as const)
          ),
          ...(nextLaunch !== s.agentLaunchConfigByPaneKey
            ? { agentLaunchConfigByPaneKey: nextLaunch }
            : {})
        }
      })
    }
  }
}

/** A pane with no record yet keeps its exited conversation from the status row that still names it. */
function exitedStatusRecord(s: AppState, paneKey: string): SleepingAgentSessionRecord | null {
  const entry = s.agentStatusByPaneKey[paneKey]
  const worktreeId = entry ? (entry.worktreeId ?? findAgentPaneWorktreeId(s, paneKey)) : null
  return entry && worktreeId
    ? resumeRecordFromStatus({
        entry,
        worktreeId,
        tabOf: () => findTabForAgentEntry(s, worktreeId, entry),
        capturedAt: entry.updatedAt,
        launchConfig: getLaunchConfigForEntry(s, entry),
        origin: 'live'
      })
    : null
}
