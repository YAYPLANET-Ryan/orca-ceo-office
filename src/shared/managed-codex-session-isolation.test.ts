import { describe, expect, it } from 'vitest'
import { planManagedCodexSessionIsolation } from './managed-codex-session-isolation'
import { applyAgentPermissionMode } from './agent-launch/permissions/tui-agent-permissions'
import { buildAgentStartupPlan } from './agent-launch/startup/tui-agent-startup'
import { buildAgentResumeStartupPlan } from './agent-launch/startup/tui-agent-resume-startup'
import { resolveTuiAgentLaunchArgs } from './agent-launch/choices/tui-agent-launch-defaults'

const cliHelp = 'Options:\n      --no-daemon\n          Run without the shared background server'

describe('managed mixed-agent session isolation', () => {
  it.each(['powershell', 'posix', 'cmd'] as const)(
    'keeps Codex launch and resume isolated while preserving Claude on %s',
    (shell) => {
      const configuredArgs = { codex: '--model test-model', claude: '--model test-claude' }
      const next = planManagedCodexSessionIsolation({ cliHelp, configuredArgs, shell })
      expect(configuredArgs.codex).toBe('--model test-model')
      expect(next.claude).toBe(configuredArgs.claude)
      const common = { cmdOverrides: {}, platform: 'win32' as const, shell }
      const codex = buildAgentStartupPlan({
        ...common,
        agent: 'codex',
        prompt: 'test task',
        agentArgs: resolveTuiAgentLaunchArgs('codex', { agentDefaultArgs: next })
      })
      expect(codex?.launchCommand).toContain('--no-daemon')
      const resume = buildAgentResumeStartupPlan({
        ...common,
        agent: 'codex',
        agentArgs: resolveTuiAgentLaunchArgs('codex', { agentDefaultArgs: next }),
        providerSession: { key: 'session_id', id: 'original-codex-session' }
      })
      expect(resume?.launchCommand).toContain('--no-daemon')
      expect(resume?.launchCommand).toContain('original-codex-session')
      const claude = buildAgentResumeStartupPlan({
        ...common,
        agent: 'claude',
        agentArgs: resolveTuiAgentLaunchArgs('claude', { agentDefaultArgs: next }),
        providerSession: { key: 'session_id', id: 'original-claude-session' }
      })
      expect(claude?.launchCommand).toContain('original-claude-session')
      expect(claude?.launchCommand).not.toContain('--no-daemon')
    }
  )

  it('is idempotent and survives changing permission mode', () => {
    const next = planManagedCodexSessionIsolation({
      cliHelp,
      configuredArgs: { codex: '' },
      shell: 'posix'
    })
    expect(
      planManagedCodexSessionIsolation({ cliHelp, configuredArgs: next, shell: 'posix' })
    ).toEqual(next)
    const manual = applyAgentPermissionMode({
      mode: 'manual',
      agentDefaultArgs: next,
      agentDefaultEnv: {}
    })
    expect(manual.agentDefaultArgs.codex).toContain('--no-daemon')
  })

  it('does not mistake a prompt after the option terminator for the isolation flag', () => {
    const next = planManagedCodexSessionIsolation({
      cliHelp,
      configuredArgs: { codex: '-- --no-daemon' },
      shell: 'posix'
    })
    expect(next.codex).toBe('--no-daemon -- --no-daemon')
  })

  it('does not alter older CLIs or explicitly remote invocations', () => {
    expect(() =>
      planManagedCodexSessionIsolation({ cliHelp, configuredArgs: {}, shell: 'posix' })
    ).toThrow('must be explicit')
    expect(() =>
      planManagedCodexSessionIsolation({ cliHelp: 'old CLI', configuredArgs: {}, shell: 'posix' })
    ).toThrow('does not advertise')
    expect(() =>
      planManagedCodexSessionIsolation({
        cliHelp,
        configuredArgs: { codex: '--remote unix://' },
        shell: 'posix'
      })
    ).toThrow('execution-host')
  })
})
