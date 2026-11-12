import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import { request } from 'node:http'
import { createProgramStatusProjector } from '../../../../shared/program-status/agent-status-projector'
import type { AgentHookServer } from '../agent-hook-server'
import {
  FIXTURE_AGENT_PROCESS,
  FIXTURE_LAUNCH_TOKEN,
  withFixtureLaunchToken
} from './attested-hook-context.test-fixtures'

export const LEAF_1 = '11111111-1111-4111-8111-111111111111'
export const LEAF_2 = '22222222-2222-4222-8222-222222222222'
export const LEAF_3 = '33333333-3333-4333-8333-333333333333'
export const LEAF_4 = '44444444-4444-4444-8444-444444444444'
export const LEAF_5 = '55555555-5555-4555-8555-555555555555'
export const PANE = makePaneKey('tab-1', LEAF_1)
export const GOOD_PANE = makePaneKey('tab-good', LEAF_2)
export const OLD_PANE = makePaneKey('tab-old', LEAF_3)
export const FRESH_PANE = makePaneKey('tab-fresh', LEAF_4)
export const TAB_A_PANE = makePaneKey('tab-A', LEAF_5)
export const RUNNING_SHELL = { id: 'shell-1', type: 'shell', status: 'running' }

export type Body = {
  paneKey: string
  launchToken?: string
  tabId?: string
  worktreeId?: string
  hookEventName?: string
  env?: string
  version?: string
  agentProcess?: string
  tmuxPane?: string
  payload: Record<string, unknown>
}

export type AgentHookServerCacheInternals = {
  assistantMessageRetryTimers: Map<string, number | ReturnType<typeof globalThis.setTimeout>>
  promptSentDedupeByPaneKey: Map<string, unknown>
  runtimeObservedStatusPaneKeys: Set<string>
  scheduleStatusPersist: () => void
}

// Hooks from a pane's own PTY carry its launch token and a process claim; an attested fixture
// server admits exactly these. Pass `launchToken: undefined` or `agentProcess: undefined` to omit.
export function buildBody(payload: Record<string, unknown>, overrides: Partial<Body> = {}): Body {
  const body: Body = {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    env: 'production',
    launchToken: FIXTURE_LAUNCH_TOKEN,
    agentProcess: FIXTURE_AGENT_PROCESS,
    payload,
    ...overrides
  }
  for (const key of ['launchToken', 'agentProcess'] as const) {
    if (body[key] === undefined) {
      delete body[key]
    }
  }
  return body
}

/** Feed one OSC 7501 report to the server as the runtime does: its facet, then its status row. */
export function ingestProgramStatusOsc(server: AgentHookServer, osc: string) {
  const { payloads, facet } = createProgramStatusProjector().process(osc)
  server.ingestProgramStatusFacet({ paneKey: PANE, facet: facet ?? null })
  const event = {
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    fromProgramStatus: true as const,
    payload: payloads[0]!.payload
  }
  server.ingestTerminalStatus(event)
  return event
}

// Stay within the seven-day hydration limit without racing now.
export function recentTs(offsetMs = 0): number {
  return Date.now() - 60 * 60 * 1000 + offsetMs
}

// Fork 6d65165647 admits Claude/Codex hooks only with a process claim, so the default body carries
// the fixture process. Other providers post none upstream; giving them the same fixture process
// would make every agent in a test look like one OS process.
function forGuardedSource(body: Body, path: string): Body {
  if (
    path === '/hook/claude' ||
    path === '/hook/codex' ||
    body.agentProcess !== FIXTURE_AGENT_PROCESS
  ) {
    return body
  }
  const { agentProcess: _, ...rest } = body
  return rest
}

export async function postHookEvent(
  server: AgentHookServer,
  body: Body,
  path: string = '/hook/claude'
): Promise<Response> {
  const env = server.buildPtyEnv()
  const port = Number(env.ORCA_AGENT_HOOK_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Own hook fixture listener is unavailable')
  }
  return new Promise<Response>((resolve, reject) => {
    const req = request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: {
          'Content-Type': 'application/json',
          Connection: 'close',
          'X-Orca-Agent-Hook-Token': env.ORCA_AGENT_HOOK_TOKEN
        }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => {
          try {
            const status = res.statusCode ?? 0
            const headers = new Headers()
            for (let i = 0; i < res.rawHeaders.length; i += 2) {
              headers.append(res.rawHeaders[i], res.rawHeaders[i + 1])
            }
            resolve(
              new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
                status,
                headers
              })
            )
          } catch (error) {
            reject(error)
          }
        })
      }
    )
    req.on('error', reject)
    req.end(JSON.stringify(forGuardedSource(withFixtureLaunchToken(server, body), path)))
  })
}
