import type { PtyProcessInfo } from './pty-process-info'
import { readHookResumeIntent } from '../../shared/agent-hook-listener/state/hook-resume-intent'

function optionalPattern(value: unknown, pattern: RegExp): boolean {
  return value === undefined || (typeof value === 'string' && pattern.test(value))
}

export function readPtyHookContextMetadata(value: PtyProcessInfo) {
  const resumeIntent = readHookResumeIntent(value.hookResumeIntent)
  if (
    !optionalPattern(value.ownerClientInstanceId, /^[a-f0-9]{64}$/) ||
    !optionalPattern(value.launchTokenHash, /^[a-f0-9]{64}$/) ||
    !optionalPattern(value.rootProcessCreationKey, /^\d{15,20}$/) ||
    (value.contextCwd !== undefined &&
      (typeof value.contextCwd !== 'string' ||
        !value.contextCwd ||
        value.contextCwd.length > 8192 ||
        value.contextCwd.includes('\0'))) ||
    (value.paneBound !== undefined && typeof value.paneBound !== 'boolean') ||
    (value.hookResumeIntent !== undefined && resumeIntent === undefined)
  ) {
    throw new Error('invalid_pty_process_list')
  }
  return {
    ...(value.ownerClientInstanceId !== undefined
      ? { ownerClientInstanceId: value.ownerClientInstanceId }
      : {}),
    ...(value.launchTokenHash !== undefined ? { launchTokenHash: value.launchTokenHash } : {}),
    ...(value.contextCwd !== undefined ? { contextCwd: value.contextCwd } : {}),
    ...(value.rootProcessCreationKey !== undefined
      ? { rootProcessCreationKey: value.rootProcessCreationKey }
      : {}),
    ...(value.paneBound !== undefined ? { paneBound: value.paneBound } : {}),
    ...(resumeIntent !== undefined ? { hookResumeIntent: resumeIntent } : {})
  }
}
