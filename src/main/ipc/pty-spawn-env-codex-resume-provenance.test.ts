import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { spawnMock } from './pty-ipc-mock-registry'
import { posixOnlyIt, TEST_MANAGED_ROOT } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { prepareCodexSessionResume } from '../codex/codex-session-resume-preparation'
import { registerPtyHandlers, setLocalPtyProvider, type PrepareCodexSessionResume } from './pty'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

describe('registerPtyHandlers', () => {
  const { handlers, mainWindow, createMockProc } = setupPtyIpcSuite()

  describe('spawn environment', () => {
    describe('unverifiable Codex resume provenance', () => {
      const RESUME_SESSION_ID = '019f81b9-19a9-7651-a8d1-352d9420bd11'
      const ORIGIN_HOME = join(TEST_MANAGED_ROOT, 'origin', 'home')
      const OTHER_HOME = join(TEST_MANAGED_ROOT, 'other', 'home')
      const ORIGIN_ROLLOUT = join(
        ORIGIN_HOME,
        'sessions',
        '2026',
        '07',
        '20',
        `rollout-2026-07-20T12-00-00-${RESUME_SESSION_ID}.jsonl`
      )

      // Why: main's real provenance rule via the same prepareCodexSessionResume that
      // index.ts calls, so the outcome wiring is exercised rather than restated. This
      // suite mocks fs, so the rollout is declared present — the only variable left is
      // whether its home is trusted, which is exactly the case the guard exists for.
      const prepareResumeWithTrustedHomes =
        (trustedHomes: readonly string[]): PrepareCodexSessionResume =>
        ({ providerSession }) =>
          prepareCodexSessionResume({
            sessionId: providerSession.id,
            transcriptPath: providerSession.transcriptPath,
            trustedCodexHomes: trustedHomes,
            // Why: these cases assert provenance gating, never the legacy rescan's home ranking
            // (#10801) — each passes a single trusted home, so no ranking can move the winner.
            getSelectedAccountCodexHome: () => null,
            systemCodexHomePath: null,
            sharedRuntimeCodexHomePath: null,
            fileIsRegular: () => true,
            resolveVerifiedResumeHome: async (source) => source.homePath
          })

      function registerWithTrustedHomes(trustedHomes: readonly string[], selectedHome: string) {
        const selectedHomeMock = vi.fn(() => selectedHome)
        registerPtyHandlers(
          mainWindow as never,
          undefined,
          selectedHomeMock,
          undefined,
          undefined,
          undefined,
          { prepareCodexSessionResume: prepareResumeWithTrustedHomes(trustedHomes) }
        )
        return selectedHomeMock
      }

      async function spawnCodexResume(
        transcriptPath: string | undefined,
        overrides: { command?: string; env?: Record<string, string> } = {}
      ): Promise<{ agentResumeUnavailable?: true }> {
        return (await handlers.get('pty:spawn')!(null, {
          cols: 80,
          rows: 24,
          cwd: '/tmp',
          command: overrides.command ?? `codex 'resume' '${RESUME_SESSION_ID}'`,
          ...(overrides.env ? { env: overrides.env } : {}),
          launchAgent: 'codex',
          resumeProviderSession: {
            key: 'session_id',
            id: RESUME_SESSION_ID,
            ...(transcriptPath ? { transcriptPath } : {})
          }
        })) as { agentResumeUnavailable?: true }
      }

      /** A daemon-shaped provider: the only local path that reports reattach results and
       *  the only one that surfaces the resolved spawn options this guard rewrites. */
      function setupResumeDaemonProvider(spawnResult: { isReattach?: true } = {}) {
        const daemonSpawn = vi.fn(
          async (options: {
            sessionId?: string
            command?: string
            env: Record<string, string>
          }) => {
            void options
            return { id: options.sessionId ?? 'daemon-pty', ...spawnResult }
          }
        )
        setLocalPtyProvider({
          spawn: daemonSpawn,
          supportsGitCredentialGuardHost: () => true,
          supportsAgentSessionClaims: () => true,
          supportsAgentSessionCreateOperations: () => true,
          write: vi.fn(),
          resize: vi.fn(),
          kill: vi.fn(),
          shutdown: vi.fn(),
          onData: vi.fn(() => vi.fn()),
          onExit: vi.fn(() => vi.fn()),
          listProcesses: vi.fn(async () => []),
          getForegroundProcess: vi.fn(async () => null)
        } as never)
        return daemonSpawn
      }

      it.each([
        ['untrusted home', ORIGIN_ROLLOUT],
        ['cross-agent metadata', '/Users/example/.claude/projects/repo/x.jsonl'],
        ['missing transcript', undefined]
      ])('refuses a fresh conversation when resume has %s', async (_label, transcriptPath) => {
        const daemonSpawn = setupResumeDaemonProvider()
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)
        await expect(spawnCodexResume(transcriptPath)).rejects.toThrow(
          /could not verify the originating Codex session file/
        )
        expect(daemonSpawn).not.toHaveBeenCalled()
        expect(spawnMock).not.toHaveBeenCalled()
      })
      posixOnlyIt('still pins CODEX_HOME and resumes when provenance is verified', async () => {
        const mockProc = createMockProc()
        spawnMock.mockReturnValue(mockProc.proc)
        vi.useFakeTimers()

        try {
          const selectedHome = registerWithTrustedHomes([ORIGIN_HOME], OTHER_HOME)
          const spawned = await spawnCodexResume(ORIGIN_ROLLOUT)

          await Promise.resolve()
          vi.runAllTimers()
          await Promise.resolve()
          vi.runAllTimers()

          expect(mockProc.proc.write).toHaveBeenCalledWith(
            `codex 'resume' '${RESUME_SESSION_ID}'\n`
          )
          expect(spawned.agentResumeUnavailable).toBeUndefined()
          const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
          expect(env.CODEX_HOME).toBe(ORIGIN_HOME)
          expect(selectedHome).not.toHaveBeenCalled()
        } finally {
          vi.useRealTimers()
        }
      })
      it('refuses an unstrippable resume whose metadata claimed Codex layout', async () => {
        // Why: the locator survives in the command, so launching could still cross accounts.
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)

        await expect(
          spawnCodexResume(ORIGIN_ROLLOUT, {
            command: `codex 'resume' '${RESUME_SESSION_ID}' --sandbox`
          })
        ).rejects.toThrow(/could not verify the originating Codex session file/)
      })
      it('rejects cross-agent metadata even for a compound resume command', async () => {
        const daemonSpawn = setupResumeDaemonProvider()
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)
        await expect(
          spawnCodexResume('/Users/example/.claude/projects/repo/x.jsonl', {
            command: `cd '/tmp/${RESUME_SESSION_ID}' && codex 'resume' '${RESUME_SESSION_ID}'`
          })
        ).rejects.toThrow(/could not verify the originating Codex session file/)
        expect(daemonSpawn).not.toHaveBeenCalled()
      })
      it('blocks an unverifiable sequenced startup before daemon spawn', async () => {
        const daemonSpawn = setupResumeDaemonProvider()
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)
        await expect(
          spawnCodexResume(ORIGIN_ROLLOUT, {
            env: { ORCA_SEQUENCED_STARTUP_COMMAND: `codex 'resume' '${RESUME_SESSION_ID}'` }
          })
        ).rejects.toThrow(/could not verify the originating Codex session file/)
        expect(daemonSpawn).not.toHaveBeenCalled()
      })
      it('leaves the sequenced startup command alone when provenance is verified', async () => {
        const daemonSpawn = setupResumeDaemonProvider()
        registerWithTrustedHomes([ORIGIN_HOME], OTHER_HOME)
        const sequenced = `codex 'resume' '${RESUME_SESSION_ID}'`

        await spawnCodexResume(ORIGIN_ROLLOUT, {
          env: { ORCA_SEQUENCED_STARTUP_COMMAND: sequenced }
        })

        expect(daemonSpawn.mock.calls.at(-1)![0].env.ORCA_SEQUENCED_STARTUP_COMMAND).toBe(sequenced)
      })
      posixOnlyIt('blocks an unverifiable local-provider startup before shell spawn', async () => {
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)
        await expect(
          spawnCodexResume(ORIGIN_ROLLOUT, {
            env: { ORCA_SEQUENCED_STARTUP_COMMAND: `codex 'resume' '${RESUME_SESSION_ID}'` }
          })
        ).rejects.toThrow(/could not verify the originating Codex session file/)
        expect(spawnMock).not.toHaveBeenCalled()
      })
      posixOnlyIt(
        'leaves the local-provider sequenced startup command alone when provenance is verified',
        async () => {
          const mockProc = createMockProc()
          spawnMock.mockReturnValue(mockProc.proc)
          registerWithTrustedHomes([ORIGIN_HOME], OTHER_HOME)
          const sequenced = `codex 'resume' '${RESUME_SESSION_ID}'`

          await spawnCodexResume(ORIGIN_ROLLOUT, {
            env: { ORCA_SEQUENCED_STARTUP_COMMAND: sequenced }
          })

          const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
          expect(env.ORCA_SEQUENCED_STARTUP_COMMAND).toBe(sequenced)
        }
      )
      it('does not rely on a possible later reattach to bypass provenance', async () => {
        const daemonSpawn = setupResumeDaemonProvider({ isReattach: true })
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)
        await expect(spawnCodexResume(ORIGIN_ROLLOUT)).rejects.toThrow(
          /could not verify the originating Codex session file/
        )
        expect(daemonSpawn).not.toHaveBeenCalled()
      })
      it.each([
        { transcriptPath: ORIGIN_ROLLOUT, trusted: false },
        { transcriptPath: undefined, trusted: false },
        { transcriptPath: '/Users/example/.claude/projects/repo/session.jsonl', trusted: false },
        { transcriptPath: ORIGIN_ROLLOUT, trusted: true }
      ])('preserves explicit runtime resume intent: %j', async ({ transcriptPath, trusted }) => {
        const daemonSpawn = setupResumeDaemonProvider()
        const runtime = {
          setPtyController: vi.fn(),
          registerPty: vi.fn(),
          noteTerminalSpawnCommand: vi.fn(),
          onPtySpawned: vi.fn(),
          onPtyExit: vi.fn(),
          onPtyData: vi.fn()
        }
        handlers.clear()
        registerPtyHandlers(
          mainWindow as never,
          runtime as never,
          vi.fn(() => OTHER_HOME),
          undefined,
          undefined,
          undefined,
          {
            prepareCodexSessionResume: prepareResumeWithTrustedHomes([
              trusted ? ORIGIN_HOME : OTHER_HOME
            ])
          }
        )
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
          spawn(args: Record<string, unknown>): Promise<{ id: string }>
        }

        const spawn = controller.spawn({
          cols: 80,
          rows: 24,
          command: `codex 'resume' '${RESUME_SESSION_ID}'`,
          env: { ORCA_SEQUENCED_STARTUP_COMMAND: `codex 'resume' '${RESUME_SESSION_ID}'` },
          launchAgent: 'codex',
          resumeProviderSession: {
            key: 'session_id',
            id: RESUME_SESSION_ID,
            ...(transcriptPath ? { transcriptPath } : {})
          }
        })

        if (!trusted) {
          await expect(spawn).rejects.toThrow('could not verify the originating Codex session file')
          expect(daemonSpawn).not.toHaveBeenCalled()
          expect(runtime.registerPty).not.toHaveBeenCalled()
          return
        }
        await spawn
        const spawnOptions = daemonSpawn.mock.calls.at(-1)![0]
        expect(spawnOptions.command).toBe(`codex 'resume' '${RESUME_SESSION_ID}'`)
        expect(spawnOptions.env.ORCA_SEQUENCED_STARTUP_COMMAND).toBe(
          `codex 'resume' '${RESUME_SESSION_ID}'`
        )
      })
    })
  })
})
