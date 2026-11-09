import { createHash } from 'node:crypto'
import { parsePaneKey } from '../../../shared/workspace-layout/stable-pane-id'
import { normalizeAgentProviderSession } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { LaunchResumeIdentityEvent } from './launch-resume-identity-event'
import { MAX_PANE_KEY_LEN } from '../../../shared/agent-hook-listener/listener-limits'

export type UnverifiedResumeLaunchRecipe = {
  verification: 'unverified'
  paneKey: string
  worktreeId?: string
  agentType: 'claude' | 'codex'
  providerSession: AgentProviderSessionMetadata
  launchedAt: number
}

function boundedText(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= limit && !value.includes('\0')
  )
}

export function isValidResumeRecipeClosure(tabId: string, closedAt: number): boolean {
  return (
    boundedText(tabId, MAX_PANE_KEY_LEN) &&
    tabId === tabId.trim() &&
    Number.isSafeInteger(closedAt) &&
    closedAt > 0
  )
}

/** A resume request is history metadata, never evidence that a process owns its provider ID. */
export function projectResumeLaunchRecipe(
  event: LaunchResumeIdentityEvent
): UnverifiedResumeLaunchRecipe | null {
  const providerSession = normalizeAgentProviderSession(event.providerSession)
  if (
    (event.agentType !== 'claude' && event.agentType !== 'codex') ||
    !boundedText(event.paneKey, MAX_PANE_KEY_LEN) ||
    event.paneKey !== event.paneKey.trim() ||
    !parsePaneKey(event.paneKey) ||
    (event.worktreeId !== undefined && !boundedText(event.worktreeId, 8192)) ||
    (event.worktreeId !== undefined && event.worktreeId !== event.worktreeId.trim()) ||
    !Number.isSafeInteger(event.launchedAt) ||
    event.launchedAt <= 0 ||
    !providerSession ||
    providerSession.key !== event.providerSession.key ||
    providerSession.id !== event.providerSession.id ||
    providerSession.transcriptPath !== event.providerSession.transcriptPath ||
    providerSession.cwd !== event.providerSession.cwd ||
    providerSession.effort !== event.providerSession.effort ||
    !boundedText(providerSession.id, 2048) ||
    (providerSession.transcriptPath !== undefined &&
      !boundedText(providerSession.transcriptPath, 8192)) ||
    (providerSession.cwd !== undefined && !boundedText(providerSession.cwd, 8192)) ||
    (providerSession.effort !== undefined && !boundedText(providerSession.effort, 128))
  ) {
    return null
  }
  const recipe: UnverifiedResumeLaunchRecipe = {
    verification: 'unverified',
    paneKey: event.paneKey,
    ...(event.worktreeId !== undefined ? { worktreeId: event.worktreeId } : {}),
    agentType: event.agentType,
    providerSession: {
      key: providerSession.key,
      id: providerSession.id,
      ...(providerSession.transcriptPath !== undefined
        ? { transcriptPath: providerSession.transcriptPath }
        : {}),
      ...(providerSession.cwd !== undefined ? { cwd: providerSession.cwd } : {}),
      ...(providerSession.effort !== undefined ? { effort: providerSession.effort } : {})
    },
    launchedAt: event.launchedAt
  }
  return Buffer.byteLength(JSON.stringify(recipe)) <= 16 * 1024 ? recipe : null
}

export function resumeLaunchRecipeKey(recipe: UnverifiedResumeLaunchRecipe): string {
  return createHash('sha256').update(JSON.stringify(recipe)).digest('hex')
}

export function decodeResumeLaunchRecipe(text: string): UnverifiedResumeLaunchRecipe {
  if (Buffer.byteLength(text) > 16 * 1024) {
    throw new Error('Resume recipe metadata too large')
  }
  const raw: unknown = JSON.parse(text)
  if (
    !raw ||
    typeof raw !== 'object' ||
    !('verification' in raw) ||
    raw.verification !== 'unverified' ||
    !('paneKey' in raw) ||
    typeof raw.paneKey !== 'string' ||
    !('agentType' in raw) ||
    typeof raw.agentType !== 'string' ||
    !('launchedAt' in raw) ||
    typeof raw.launchedAt !== 'number' ||
    !('providerSession' in raw) ||
    ('worktreeId' in raw && typeof raw.worktreeId !== 'string')
  ) {
    throw new Error('Invalid unverified resume recipe')
  }
  const providerSession = normalizeAgentProviderSession(raw.providerSession)
  const projected =
    providerSession &&
    projectResumeLaunchRecipe({
      paneKey: raw.paneKey,
      ...('worktreeId' in raw && typeof raw.worktreeId === 'string'
        ? { worktreeId: raw.worktreeId }
        : {}),
      agentType: raw.agentType,
      providerSession,
      launchedAt: raw.launchedAt
    })
  if (!projected || JSON.stringify(projected) !== text) {
    throw new Error('Noncanonical or unsupported resume recipe')
  }
  return projected
}
