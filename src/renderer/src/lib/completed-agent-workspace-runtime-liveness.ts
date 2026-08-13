import type { AppState } from '@/store/types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import type {
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../../shared/runtime-types'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'

export type CompletedAgentWorkspaceRuntimePtyLiveness = {
  runtimeLivePtyIdsByWorktreeId: Record<string, string[]>
  runtimeLivenessRequiredWorktreeIds: string[]
}

function getTypedRuntimePtyId(terminal: RuntimeTerminalSummary): string | null {
  if (terminal.ptyId) {
    return terminal.ptyId
  }
  if (terminal.tabId.startsWith('pty:') && terminal.tabId === terminal.leafId) {
    return terminal.tabId.slice('pty:'.length) || null
  }
  return null
}

export async function collectCompletedAgentWorkspaceRuntimePtyLiveness(
  state: AppState
): Promise<CompletedAgentWorkspaceRuntimePtyLiveness> {
  const targets = new Map<string, string>()
  for (const worktreeId of Object.keys(state.tabsByWorktree)) {
    const environmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
    if (environmentId) {
      targets.set(worktreeId, environmentId)
    }
  }
  const runtimeLivePtyIdsByWorktreeId: Record<string, string[]> = {}
  await Promise.all(
    [...targets].map(async ([worktreeId, environmentId]) => {
      try {
        const result = await callRuntimeRpc<RuntimeTerminalListResult>(
          { kind: 'environment', environmentId },
          'terminal.list',
          {
            worktree: toRuntimeWorktreeSelector(worktreeId),
            limit: 10_000,
            requireFreshPtyLiveness: true,
            includeVisualLayouts: false
          },
          { timeoutMs: 10_000 }
        )
        if (result.truncated) {
          return
        }
        const ptyIds = new Set<string>()
        for (const terminal of result.terminals) {
          if (!terminal.connected || terminal.worktreeId !== worktreeId) {
            continue
          }
          const ptyId = getTypedRuntimePtyId(terminal)
          if (ptyId) {
            ptyIds.add(ptyId)
          }
        }
        runtimeLivePtyIdsByWorktreeId[worktreeId] = [...ptyIds].sort()
      } catch {
        // Missing authoritative liveness makes the planner fail closed for this pass.
      }
    })
  )
  return {
    runtimeLivePtyIdsByWorktreeId,
    runtimeLivenessRequiredWorktreeIds: [...targets.keys()]
  }
}
