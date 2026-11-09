import type { ParsedHookEnvelope } from '../../../shared/agent-hook-listener/hook-envelope'
import type { HookTransportPeer } from '../../../shared/agent-hook-listener/presence/hook-process-root-evidence'
import type { HookProviderObservation } from '../../../shared/agent-hook-listener/state/hook-provider-observation'
import {
  hookResumeIntentsEqual,
  type HookResumeIntent
} from '../../../shared/agent-hook-listener/state/hook-resume-intent'

export type HookContextSnapshot = {
  executionHostId: 'local'
  paneKey: string
  worktreeId: string
  ptyId: string
  incarnationId: string
  launchTokenHash: string
  cwd: string
  reportedCwd: string
  ownerClientInstanceId?: string
  launchCwd?: string
  providerObservation?: HookProviderObservation
  resumeIntent?: HookResumeIntent | null
}

export type HookContextSnapshotReader = (
  envelope: ParsedHookEnvelope
) => Promise<HookContextSnapshot | null>

export type AdmittedHookContext = {
  envelope: ParsedHookEnvelope
  snapshot: HookContextSnapshot
  processRootVerified: true
  ownerExit: unknown
  peer?: HookTransportPeer
  release: () => void
}

export function sameHookContextSnapshot(a: HookContextSnapshot, b: HookContextSnapshot): boolean {
  return (
    a.executionHostId === b.executionHostId &&
    a.paneKey === b.paneKey &&
    a.worktreeId === b.worktreeId &&
    a.ptyId === b.ptyId &&
    a.incarnationId === b.incarnationId &&
    a.launchTokenHash === b.launchTokenHash &&
    a.cwd === b.cwd &&
    a.reportedCwd === b.reportedCwd &&
    a.ownerClientInstanceId === b.ownerClientInstanceId &&
    a.launchCwd === b.launchCwd &&
    hookResumeIntentsEqual(a.resumeIntent, b.resumeIntent)
  )
}
