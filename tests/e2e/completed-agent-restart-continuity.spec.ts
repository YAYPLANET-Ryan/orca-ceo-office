import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { TEST_REPO_PATH_FILE } from './global-setup'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { cleanupE2EDaemons } from './helpers/electron-process-shutdown'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../src/shared/orca-profiles'

const SESSION_ID = 'e2e-completed-conversation'
const MODEL = 'gpt-continuity-test'

function useHermeticResume(userDataDir: string): void {
  const dataPath = path.join(
    userDataDir,
    'profiles',
    DEFAULT_LOCAL_ORCA_PROFILE_ID,
    'orca-data.json'
  )
  const data = JSON.parse(readFileSync(dataPath, 'utf8'))
  const records = data.workspaceSession.sleepingAgentSessionsByPaneKey as Record<
    string,
    { providerSession?: { id: string }; launchConfig?: unknown }
  >
  const record = Object.values(records).find((entry) => entry.providerSession?.id === SESSION_ID)
  expect(record, 'the completed conversation must survive on disk').toBeDefined()
  // Why: echo exercises the actual shell and resume command without credentials or a model call.
  record!.launchConfig = {
    agentCommand: `echo '--model' '${MODEL}' '-c' 'model_reasoning_effort=medium'`,
    agentArgs: `--model ${MODEL} -c model_reasoning_effort=medium`,
    agentEnv: {}
  }
  writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

for (const coldRestart of [false, true]) {
  test(`preserves a completed conversation after ${coldRestart ? 'daemon loss' : 'app restart'}`, async (// oxlint-disable-next-line no-empty-pattern -- Restart tests own both Electron launches instead of using the single-app fixture.
  {}, testInfo) => {
    test.setTimeout(180_000)
    const repoPath = readFileSync(TEST_REPO_PATH_FILE, 'utf8').trim()
    const session = createRestartSession(testInfo)
    let app: ElectronApplication | null = null
    try {
      const first = await session.launch()
      app = first.app
      await attachRepoAndOpenTerminal(first.page, repoPath)
      await waitForSessionReady(first.page)
      await ensureTerminalVisible(first.page)
      await waitForActiveTerminalManager(first.page, 30_000)
      await waitForPaneCount(first.page, 1, 30_000)
      const descriptor = await waitForActivePaneHookDescriptor(first.page)
      const ptyId = await waitForActivePanePtyId(first.page)
      const marker = `PRESERVED_SCROLLBACK_${Date.now()}`
      await execInTerminal(first.page, ptyId, `echo ${marker}`)
      await waitForTerminalOutput(first.page, marker)
      const transcriptPath = session.seedCodexResumeRollout(SESSION_ID, repoPath)
      await first.page.evaluate(
        ({ paneKey, worktreeId, id, transcriptPath }) => {
          window.__store
            ?.getState()
            .setAgentStatus(
              paneKey,
              { state: 'done', prompt: 'completed test turn', agentType: 'codex' },
              'Codex',
              undefined,
              { worktreeId },
              { providerSession: { key: 'session_id', id, transcriptPath } }
            )
        },
        { ...descriptor, id: SESSION_ID, transcriptPath }
      )
      await session.close(app)
      app = null
      useHermeticResume(session.userDataDir)
      if (coldRestart) {
        // Why: stop only this isolated fixture's daemon to model a computer restart.
        await cleanupE2EDaemons(session.userDataDir)
      }
      const second = await session.launch()
      app = second.app
      await waitForSessionReady(second.page)
      await ensureTerminalVisible(second.page)
      await waitForActiveTerminalManager(second.page, 30_000)
      await waitForPaneCount(second.page, 1, 30_000)
      await waitForTerminalOutput(second.page, marker, 30_000)
      await waitForTerminalOutput(second.page, SESSION_ID, 30_000)
      await waitForTerminalOutput(second.page, MODEL, 30_000)
      await waitForTerminalOutput(second.page, 'model_reasoning_effort=medium', 30_000)
      await second.page.screenshot({ path: testInfo.outputPath('restored-conversation.png') })
    } finally {
      if (app) {
        await session.close(app)
      }
      await session.dispose()
    }
  })
}
