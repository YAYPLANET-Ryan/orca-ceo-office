import { MAX_PANE_KEY_LEN } from '../listener-limits'
import { parsePaneKey } from '../../workspace-layout/stable-pane-id'

export type HookProviderObservationScope = Readonly<{
  ptyId: string
  incarnationId: string
  paneKey: string
  worktreeId: string
  ownerClientInstanceId: string
  launchTokenHash: string
  launchCwd: string
  cwd: string
}>

/** A scoped report accepted from the attached admitting client, never clean-transcript evidence. */
export type HookProviderObservation = HookProviderObservationScope &
  Readonly<{
    version: 1
    revision: number
    agentType: 'claude' | 'codex'
    providerSessionId: string
    originalProviderSessionId?: string
    transition: 'observed' | 'requested-id-matched' | 'clear'
  }>

export type HookProviderObservationUpdate = HookProviderObservationScope &
  Readonly<{
    expectedRevision: number
    agentType: 'claude' | 'codex'
    providerSessionId: string
    transition: 'observed' | 'clear'
    launchToken: string
  }>

const SCOPE_KEYS = [
  'ptyId',
  'incarnationId',
  'paneKey',
  'worktreeId',
  'ownerClientInstanceId',
  'launchTokenHash',
  'launchCwd',
  'cwd'
]

function text(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    value === value.trim() &&
    !value.includes('\0')
  )
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function withinByteBudget(value: Record<string, unknown>): boolean {
  return new TextEncoder().encode(JSON.stringify(value)).length <= 64 * 1024
}

function scope(value: Record<string, unknown>): HookProviderObservationScope | undefined {
  if (
    !text(value.ptyId, 16384) ||
    !text(value.incarnationId, 128) ||
    !text(value.paneKey, MAX_PANE_KEY_LEN) ||
    !parsePaneKey(value.paneKey) ||
    !text(value.worktreeId, 8192) ||
    !text(value.ownerClientInstanceId, 64) ||
    !/^[a-f0-9]{64}$/.test(value.ownerClientInstanceId) ||
    !text(value.launchTokenHash, 64) ||
    !/^[a-f0-9]{64}$/.test(value.launchTokenHash) ||
    !text(value.launchCwd, 8192) ||
    !text(value.cwd, 8192)
  ) {
    return undefined
  }
  return {
    ptyId: value.ptyId,
    incarnationId: value.incarnationId,
    paneKey: value.paneKey,
    worktreeId: value.worktreeId,
    ownerClientInstanceId: value.ownerClientInstanceId,
    launchTokenHash: value.launchTokenHash,
    launchCwd: value.launchCwd,
    cwd: value.cwd
  }
}

export function readHookProviderObservation(value: unknown): HookProviderObservation | undefined {
  if (!record(value)) {
    return undefined
  }
  const selected = scope(value)
  const allowed = new Set([
    ...SCOPE_KEYS,
    'version',
    'revision',
    'agentType',
    'providerSessionId',
    'originalProviderSessionId',
    'transition'
  ])
  if (
    !selected ||
    value.version !== 1 ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    (value.agentType !== 'claude' && value.agentType !== 'codex') ||
    !text(value.providerSessionId, 2048) ||
    (value.originalProviderSessionId !== undefined &&
      !text(value.originalProviderSessionId, 2048)) ||
    (value.transition !== 'observed' &&
      value.transition !== 'requested-id-matched' &&
      value.transition !== 'clear') ||
    (value.transition === 'requested-id-matched' &&
      value.originalProviderSessionId !== value.providerSessionId) ||
    (value.transition === 'observed' && value.originalProviderSessionId !== undefined) ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    !withinByteBudget(value)
  ) {
    return undefined
  }
  return Object.freeze({
    ...selected,
    version: 1,
    revision: value.revision,
    agentType: value.agentType,
    providerSessionId: value.providerSessionId,
    ...(value.originalProviderSessionId !== undefined
      ? { originalProviderSessionId: value.originalProviderSessionId }
      : {}),
    transition: value.transition
  })
}

export function readHookProviderObservationUpdate(
  value: unknown
): HookProviderObservationUpdate | undefined {
  if (!record(value)) {
    return undefined
  }
  const selected = scope(value)
  const allowed = new Set([
    ...SCOPE_KEYS,
    'expectedRevision',
    'agentType',
    'providerSessionId',
    'transition',
    'launchToken'
  ])
  if (
    !selected ||
    typeof value.expectedRevision !== 'number' ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    (value.agentType !== 'claude' && value.agentType !== 'codex') ||
    !text(value.providerSessionId, 2048) ||
    (value.transition !== 'observed' && value.transition !== 'clear') ||
    !text(value.launchToken, 128) ||
    Object.keys(value).some((key) => !allowed.has(key)) ||
    !withinByteBudget(value)
  ) {
    return undefined
  }
  return Object.freeze({
    ...selected,
    expectedRevision: value.expectedRevision,
    agentType: value.agentType,
    providerSessionId: value.providerSessionId,
    transition: value.transition,
    launchToken: value.launchToken
  })
}
