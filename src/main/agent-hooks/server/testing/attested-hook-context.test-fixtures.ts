import { launchTokenHash } from '../../../../shared/agent-hook-listener/transport/agent-hook-spool'
import type { HookRootEvidenceReader } from '../../../../shared/agent-hook-listener/presence/hook-process-root-evidence'
import type { AgentHookServer } from '../agent-hook-server'
import type { HookContextSnapshot } from '../hook-context-snapshot'

/**
 * Upstream hook-server suites post local Claude/Codex hooks without the PTY context this fork
 * requires before a hook may own a pane (6d65165647). This harness gives a test server the
 * context a real owned PTY would report, so those suites exercise what happens after admission.
 * Admission itself (refusals, races, cwd, launch generation, process roots) stays covered by the
 * server-context-* suites, which do not use this harness.
 */
export const FIXTURE_LAUNCH_TOKEN = 'fixture-launch-token'
export const FIXTURE_INCARNATION = 'inc-1'
export const FIXTURE_CWD = '/fixture/worktree'

const attested = new WeakSet<AgentHookServer>()

export function isAttestedFixtureServer(server: AgentHookServer): boolean {
  return attested.has(server)
}

type AttestOptions = {
  /** Keep a root evidence reader the suite installed; the harness only binds its verdict. */
  keepRootEvidence?: boolean
  incarnation?: string
}

/** Attest every local hook on this server as coming from its pane's owned PTY. */
export function attestFixtureHookContext<T extends AgentHookServer>(
  server: T,
  options: AttestOptions = {}
): T {
  const incarnation = options.incarnation ?? FIXTURE_INCARNATION
  const tokenHash = launchTokenHash(FIXTURE_LAUNCH_TOKEN)
  server.setHookContextSnapshotReader(async (envelope): Promise<HookContextSnapshot | null> => {
    if (!tokenHash || !envelope.paneKey || !envelope.worktreeId) {
      return null
    }
    return {
      executionHostId: 'local',
      paneKey: envelope.paneKey,
      worktreeId: envelope.worktreeId,
      ptyId: `pty:${envelope.paneKey}`,
      incarnationId: incarnation,
      launchTokenHash: tokenHash,
      cwd: FIXTURE_CWD,
      reportedCwd: FIXTURE_CWD
    }
  })
  const internals = server as unknown as { readHookRootEvidence?: HookRootEvidenceReader }
  if (options.keepRootEvidence) {
    const suiteReader = internals.readHookRootEvidence
    if (suiteReader) {
      server.setHookRootEvidenceReader(async (request) => {
        const evidence = await suiteReader(request)
        return evidence?.verdict === 'root' ? { ...evidence, binding: incarnation } : evidence
      })
    }
  } else {
    server.setHookRootEvidenceReader(async (request) => ({
      verdict: 'root',
      binding: incarnation,
      process: request.process
    }))
  }
  attested.add(server)
  return server
}

/**
 * A process claim the host cannot probe. Its platform never matches the test host, so liveness
 * reads stay 'unverifiable' — what these suites saw before the fork required a process claim —
 * instead of a real probe declaring a made-up pid exited.
 */
export const FIXTURE_AGENT_PROCESS = JSON.stringify({
  pid: 4242,
  platform: process.platform === 'darwin' ? 'linux' : 'darwin',
  startTime: 'fixture-start'
})

/** The launch token and process claim a hook from an attested fixture PTY carries. */
export function withFixtureLaunchToken<T extends { launchToken?: string; agentProcess?: string }>(
  server: AgentHookServer,
  body: T
): T {
  if (!isAttestedFixtureServer(server)) {
    return body
  }
  return {
    ...body,
    ...(body.launchToken === undefined ? { launchToken: FIXTURE_LAUNCH_TOKEN } : {}),
    ...(body.agentProcess === undefined ? { agentProcess: FIXTURE_AGENT_PROCESS } : {})
  }
}
