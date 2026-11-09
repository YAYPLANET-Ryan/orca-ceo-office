import { normalizeAgentProviderSession } from '../../agent-session/lifecycle/agent-session-resume'

/** A host-owned launch request, never a receipt for clean conversation contents. */
export type HookResumeIntent = Readonly<{
  agentType: 'claude' | 'codex'
  providerSessionId: string
}>

/** Null declares a structured fresh request; absence means unavailable, never fresh. */
export function readHookResumeIntent(value: unknown): HookResumeIntent | null | undefined {
  if (value === null) {
    return null
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !('agentType' in value) ||
    (value.agentType !== 'claude' && value.agentType !== 'codex') ||
    !('providerSessionId' in value) ||
    typeof value.providerSessionId !== 'string' ||
    !value.providerSessionId ||
    value.providerSessionId.length > 2048 ||
    value.providerSessionId !== value.providerSessionId.trim() ||
    value.providerSessionId.includes('\0') ||
    Object.keys(value).some((key) => key !== 'agentType' && key !== 'providerSessionId')
  ) {
    return undefined
  }
  return Object.freeze({
    agentType: value.agentType,
    providerSessionId: value.providerSessionId
  })
}

export function hookResumeIntentFromLaunch(
  agent: unknown,
  requestedSession: unknown
): HookResumeIntent | null | undefined {
  if (agent !== 'claude' && agent !== 'codex') {
    return undefined
  }
  if (requestedSession === undefined || requestedSession === null) {
    // A direct command or legacy path may still resume; absence cannot declare fresh.
    return undefined
  }
  const session = normalizeAgentProviderSession(requestedSession)
  if (
    !session ||
    session.key !== 'session_id' ||
    typeof requestedSession !== 'object' ||
    !('id' in requestedSession) ||
    requestedSession.id !== session.id
  ) {
    return undefined
  }
  return readHookResumeIntent({ agentType: agent, providerSessionId: session.id })
}

export function hookResumeIntentsEqual(
  left: HookResumeIntent | null | undefined,
  right: HookResumeIntent | null | undefined
): boolean {
  return (
    left === right ||
    (left != null &&
      right != null &&
      left.agentType === right.agentType &&
      left.providerSessionId === right.providerSessionId)
  )
}
