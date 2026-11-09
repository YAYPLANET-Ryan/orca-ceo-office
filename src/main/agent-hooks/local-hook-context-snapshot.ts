import { realpath } from 'node:fs/promises'
import { isAbsolute, normalize } from 'node:path'
import type { LocalPtyInventoryReader } from './local-tmux-managed-pty'
import type { HookContextSnapshotReader } from './server/hook-context-snapshot'
import { readHookResumeIntent } from '../../shared/agent-hook-listener/state/hook-resume-intent'
import { readHookProviderObservation } from '../../shared/agent-hook-listener/state/hook-provider-observation'

export function createLocalHookContextSnapshotReader(
  readInventory: LocalPtyInventoryReader,
  canonicalize: (path: string) => Promise<string> = realpath,
  clientInstanceId?: string | (() => string | undefined)
): HookContextSnapshotReader {
  return async (envelope) => {
    const reportedCwd = envelope.hookPayloadRecord.cwd
    if (
      typeof reportedCwd !== 'string' ||
      !isAbsolute(reportedCwd) ||
      /^(?:\\\\|\/\/)/.test(reportedCwd)
    ) {
      return null
    }
    const row = await readInventory(envelope.paneKey, { bySpawnPaneKey: true, fresh: true })
    const owner = typeof clientInstanceId === 'function' ? clientInstanceId() : clientInstanceId
    if (
      !row ||
      row.exiting ||
      row.routed === false ||
      row.paneBound !== true ||
      row.ownerClientAttached !== true ||
      !owner ||
      row.ownerClientInstanceId !== owner ||
      row.wslDistro ||
      row.paneKey !== envelope.paneKey ||
      !row.worktreeId ||
      row.worktreeId !== envelope.worktreeId ||
      !row.incarnationId ||
      !row.launchTokenHash ||
      !/^[a-f0-9]{64}$/.test(row.launchTokenHash) ||
      !row.rootProcessId ||
      !row.contextCwd ||
      !isAbsolute(row.contextCwd)
    ) {
      return null
    }
    const launchCwd = row.contextCwd
    const resumeIntent = readHookResumeIntent(row.hookResumeIntent)
    const providerObservation = readHookProviderObservation(row.providerObservation)
    if (row.hookResumeIntent !== undefined && resumeIntent === undefined) {
      return null
    }
    if (row.providerObservation !== undefined && !providerObservation) {
      return null
    }
    let cwd: string
    try {
      cwd = normalize(await canonicalize(launchCwd))
    } catch {
      return null
    }
    const comparable = (path: string) => {
      const value = normalize(path).replace(/[\\/]+$/, '')
      return process.platform === 'win32' ? value.toLowerCase() : value
    }
    const reported = comparable(reportedCwd)
    if (reported !== comparable(launchCwd) && reported !== comparable(cwd)) {
      return null
    }
    if (
      providerObservation &&
      (providerObservation.ptyId !== row.id ||
        providerObservation.incarnationId !== row.incarnationId ||
        providerObservation.paneKey !== row.paneKey ||
        providerObservation.worktreeId !== row.worktreeId ||
        providerObservation.ownerClientInstanceId !== owner ||
        providerObservation.launchTokenHash !== row.launchTokenHash ||
        providerObservation.launchCwd !== launchCwd ||
        providerObservation.cwd !== cwd ||
        providerObservation.originalProviderSessionId !== resumeIntent?.providerSessionId ||
        (resumeIntent && providerObservation.agentType !== resumeIntent.agentType))
    ) {
      return null
    }
    return {
      executionHostId: 'local',
      paneKey: row.paneKey,
      worktreeId: row.worktreeId,
      ptyId: row.id,
      incarnationId: row.incarnationId,
      launchTokenHash: row.launchTokenHash,
      ownerClientInstanceId: owner,
      launchCwd,
      cwd,
      reportedCwd: cwd,
      ...(resumeIntent !== undefined ? { resumeIntent } : {}),
      ...(providerObservation ? { providerObservation } : {})
    }
  }
}
