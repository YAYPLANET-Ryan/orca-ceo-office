import { describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { spawnMock, noChatsRuntimeMembers } from './pty-ipc-mock-registry'
import { posixOnlyIt, TEST_MANAGED_ROOT } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { prepareCodexSessionResume } from '../../codex/history/resume/codex-session-resume-preparation'
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from '../../pty/shell-startup/posix-shell-startup-command'
import { registerPtyHandlers } from './register-handlers'
import { setLocalPtyProvider } from './provider/registry'
import type { PrepareCodexSessionResume } from './host-env/types'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../../pty/shell-startup/pwsh', () =>
  import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock())
)
vi.mock('../../wsl/filesystem/unc-path-access', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../../codex/configuration/homes/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../../codex/history/index/codex-state-db-backfill-recovery', () =>
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

      // Use real resume preparation with a present rollout; trust is the only rejection variable.
      const prepareResumeWithTrustedHomes =
        (trustedHomes: readonly string[]): PrepareCodexSessionResume =>
        ({ providerSession }) =>
          prepareCodexSessionResume({
            sessionId: providerSession.id,
            transcriptPath: providerSession.transcriptPath,
            trustedCodexHomes: trustedHomes,
            // One trusted home removes legacy rescan ranking from these argv-removal cases (#10801).
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

      /** Daemon-shaped provider exposes rewritten options and reattach results. */
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
        { name: 'untrusted original home', path: ORIGIN_ROLLOUT },
        { name: 'cross-agent metadata', path: '/Users/example/.claude/projects/repo/x.jsonl' },
        { name: 'missing transcript', path: undefined },
        {
          name: 'unstrippable command',
          path: ORIGIN_ROLLOUT,
          command: `codex 'resume' '${RESUME_SESSION_ID}' --sandbox`
        },
        {
          name: 'nested cross-agent command',
          path: '/Users/example/.claude/projects/repo/x.jsonl',
          command: `cd '/tmp/${RESUME_SESSION_ID}' && codex 'resume' '${RESUME_SESSION_ID}'`
        },
        {
          name: 'sequenced startup command',
          path: ORIGIN_ROLLOUT,
          env: { ORCA_SEQUENCED_STARTUP_COMMAND: `codex 'resume' '${RESUME_SESSION_ID}'` }
        }
      ])('refuses $name before a different conversation can start', async (request) => {
        const daemonSpawn = setupResumeDaemonProvider()
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)

        await expect(spawnCodexResume(request.path, request)).rejects.toThrow(
          'Orca could not verify the originating Codex session file, so automatic resume was stopped to avoid using a different account.'
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

          expect(mockProc.proc.write).not.toHaveBeenCalled()
          expect(spawned.agentResumeUnavailable).toBeUndefined()
          const env = spawnMock.mock.calls.at(-1)![2].env as Record<string, string>
          expect(env.CODEX_HOME).toBe(ORIGIN_HOME)
          expect(env[POSIX_SHELL_STARTUP_COMMAND_ENV]).toBe(`codex 'resume' '${RESUME_SESSION_ID}'`)
          expect(selectedHome).not.toHaveBeenCalled()
        } finally {
          vi.useRealTimers()
        }
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

      it('refuses an unverified request before a provider can claim reattachment', async () => {
        const daemonSpawn = setupResumeDaemonProvider({ isReattach: true })
        registerWithTrustedHomes([OTHER_HOME], OTHER_HOME)

        await expect(spawnCodexResume(ORIGIN_ROLLOUT)).rejects.toThrow(
          'Orca could not verify the originating Codex session file'
        )
        expect(daemonSpawn).not.toHaveBeenCalled()
      })
      it('refuses unverified identity on the runtime controller path', async () => {
        const daemonSpawn = setupResumeDaemonProvider()
        const runtime = {
          setPtyController: vi.fn(),
          ...noChatsRuntimeMembers(),
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
          { prepareCodexSessionResume: prepareResumeWithTrustedHomes([OTHER_HOME]) }
        )
        const controller = runtime.setPtyController.mock.calls[0]?.[0] as {
          spawn(args: Record<string, unknown>): Promise<{ id: string }>
        }

        await expect(
          controller.spawn({
            cols: 80,
            rows: 24,
            command: `codex 'resume' '${RESUME_SESSION_ID}'`,
            env: { ORCA_SEQUENCED_STARTUP_COMMAND: `codex 'resume' '${RESUME_SESSION_ID}'` },
            launchAgent: 'codex',
            resumeProviderSession: {
              key: 'session_id',
              id: RESUME_SESSION_ID,
              transcriptPath: ORIGIN_ROLLOUT
            }
          })
        ).rejects.toThrow('Orca could not verify the originating Codex session file')
        expect(daemonSpawn).not.toHaveBeenCalled()
        expect(runtime.registerPty).not.toHaveBeenCalled()
      })
    })
  })
})
