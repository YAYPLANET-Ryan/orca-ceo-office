import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { launchTokenHash } from '../../shared/agent-hook-listener/transport/agent-hook-spool'

export const HOOK_OWNER_ENV = 'ORCA_AGENT_HOOK_OWNER'

export type HookLaunchContext = {
  ownerClientInstanceId: string
  launchTokenHash: string
  cwd: string
  rootProcessCreationKey?: string
}

export function hookOwnerId(endpoint: string): string {
  return createHash('sha256').update(`orca-hook-owner:${endpoint}`).digest('hex')
}

export function captureHookLaunchContext(
  env: Readonly<Record<string, string>> | undefined,
  cwd: string,
  rootProcessCreationKey?: string | null
): HookLaunchContext | undefined {
  const owner = env?.[HOOK_OWNER_ENV]
  const token = env?.ORCA_AGENT_LAUNCH_TOKEN
  const hash = token && token.length <= 128 ? launchTokenHash(token) : null
  return owner && /^[a-f0-9]{64}$/.test(owner) && hash && isAbsolute(cwd)
    ? {
        ownerClientInstanceId: owner,
        launchTokenHash: hash,
        cwd,
        ...(rootProcessCreationKey ? { rootProcessCreationKey } : {})
      }
    : undefined
}

export function readHookLaunchContext(value: unknown): HookLaunchContext | undefined {
  if (
    !value ||
    typeof value !== 'object' ||
    !('ownerClientInstanceId' in value) ||
    !('launchTokenHash' in value) ||
    !('cwd' in value)
  ) {
    return undefined
  }
  const { ownerClientInstanceId, launchTokenHash, cwd } = value
  const rootProcessCreationKey =
    'rootProcessCreationKey' in value ? value.rootProcessCreationKey : undefined
  return typeof ownerClientInstanceId === 'string' &&
    /^[a-f0-9]{64}$/.test(ownerClientInstanceId) &&
    typeof launchTokenHash === 'string' &&
    /^[a-f0-9]{64}$/.test(launchTokenHash) &&
    typeof cwd === 'string' &&
    isAbsolute(cwd) &&
    (rootProcessCreationKey === undefined ||
      (typeof rootProcessCreationKey === 'string' && /^\d{15,20}$/.test(rootProcessCreationKey)))
    ? {
        ownerClientInstanceId,
        launchTokenHash,
        cwd,
        ...(rootProcessCreationKey ? { rootProcessCreationKey } : {})
      }
    : undefined
}
