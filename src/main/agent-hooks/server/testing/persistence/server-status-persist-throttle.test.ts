import { holdSavedStatusLock, readSavedStatus } from './last-status.test-fixtures'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer, _internals } from '../../agent-hook-server'
import { buildBody, PANE, postHookEvent } from '../server.test-fixtures'
import { launchTokenHash } from '../../../../../shared/agent-hook-listener/transport/agent-hook-spool'
import type { HookContextSnapshotReader } from '../../hook-context-snapshot'

import {
  attestFixtureHookContext,
  FIXTURE_LAUNCH_TOKEN
} from '../attested-hook-context.test-fixtures'
vi.mock('../../../../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../../../../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: vi.fn(() => ({ nth_repo_added: 2 }))
}))

describe('saved agent status cadence', () => {
  let userDataPath: string
  let server: AgentHookServer
  let ptyLaunchToken = FIXTURE_LAUNCH_TOKEN

  // Fork 6d65165647: a new launch token is admitted only when the pane's PTY exported it, so the
  // fixture PTY reports the token of its latest launch.
  const followPtyLaunchToken = (target: AgentHookServer): AgentHookServer => {
    const fixtureRead = (
      target as unknown as { readHookContextSnapshot: HookContextSnapshotReader }
    ).readHookContextSnapshot
    target.setHookContextSnapshotReader(async (envelope) => {
      const snapshot = await fixtureRead(envelope)
      return snapshot && { ...snapshot, launchTokenHash: launchTokenHash(ptyLaunchToken) ?? '' }
    })
    return target
  }

  const lastStatusPath = (): string => join(userDataPath, 'agent-hooks', 'last-status.json')
  const readPrompt = (): unknown =>
    JSON.parse(readSavedStatus(lastStatusPath())).entries[PANE]?.payload?.prompt
  const prompt = (text: string, launchToken?: string): Promise<Response> => {
    if (launchToken) {
      ptyLaunchToken = launchToken
    }
    return postHookEvent(
      server,
      buildBody(
        { hook_event_name: 'UserPromptSubmit', prompt: text },
        launchToken ? { launchToken } : {}
      )
    )
  }

  beforeEach(async () => {
    _internals.resetCachesForTests()
    // Real loopback POSTs need fake time to advance.
    vi.useFakeTimers({
      shouldAdvanceTime: true,
      toFake: ['setTimeout', 'clearTimeout', 'Date']
    })
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-persist-throttle-'))
    ptyLaunchToken = FIXTURE_LAUNCH_TOKEN
    server = followPtyLaunchToken(attestFixtureHookContext(new AgentHookServer()))
    await server.start({ env: 'production', userDataPath })
  })

  afterEach(() => {
    server.stop()
    vi.useRealTimers()
    vi.restoreAllMocks()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('saves an authority change at once while a routine update waits for the window', async () => {
    await prompt('first')
    await vi.advanceTimersByTimeAsync(1)
    expect(readPrompt()).toBe('first')

    await prompt('second')
    await vi.advanceTimersByTimeAsync(1)
    expect(readPrompt()).toBe('first')

    await prompt('third', 'launch-token-new')
    await vi.advanceTimersByTimeAsync(1)
    expect(JSON.parse(readSavedStatus(lastStatusPath())).entries[PANE]).toMatchObject({
      launchTokenHash: expect.any(String),
      payload: expect.objectContaining({ prompt: 'third' })
    })
  })

  it('saves the latest status at stop and a restart keeps it', async () => {
    await prompt('first')
    await vi.advanceTimersByTimeAsync(1)
    await prompt('final before stop')

    server.stop()
    expect(readPrompt()).toBe('final before stop')

    await server.start({ env: 'production', userDataPath })
    expect(server.getStatusSnapshot()[0]?.prompt).toBe('final before stop')
  })

  it('saves an authority change within seconds once a held lock clears', async () => {
    await prompt('first')
    await vi.advanceTimersByTimeAsync(1)
    const release = holdSavedStatusLock(lastStatusPath())
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await prompt('new owner', 'launch-token-new')
    await vi.advanceTimersByTimeAsync(1)
    release()

    await vi.advanceTimersByTimeAsync(2_000)
    expect(readPrompt()).toBe('new owner')
  })
})
