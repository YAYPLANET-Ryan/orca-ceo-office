import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan, buildAgentStartupPlan } from './tui-agent-startup'
import { TUI_AGENT_CONFIG } from './tui-agent-config'

// Why: Codex 0.162+ runs a shared app-server daemon that executes the agent
// hooks with the environment of whichever pane started it, so every other
// pane's session was attributed to that pane and never got a sleeping record
// (2026-10-16 reboot test). The `--no-daemon` launch contract keeps hooks in
// the pane's own process tree on every launch path.
describe('Codex --no-daemon launch contract', () => {
  it('declares the contract on the Codex agent config only', () => {
    expect(TUI_AGENT_CONFIG.codex.launchArgs).toEqual(['--no-daemon'])
    expect(TUI_AGENT_CONFIG.claude.launchArgs).toBeUndefined()
  })

  it('does not duplicate a no-daemon flag the Codex override already carries', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'fix it',
      cmdOverrides: { codex: 'codex --no-daemon --profile work' },
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("codex --no-daemon --profile work 'fix it'")
  })

  it('launches Codex with --no-daemon on Windows shells too', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: {},
      platform: 'win32',
      shell: 'cmd',
      allowEmptyPromptLaunch: true
    })

    expect(plan?.launchCommand).toBe('codex "--no-daemon"')
    expect(plan?.launchConfig.agentCommand).toBe('codex "--no-daemon"')
  })

  it('inserts the contract into resumes captured before it existed', () => {
    // Why: sleeping records written by earlier builds persisted `codex` alone;
    // resuming them under the shared daemon would re-open the attribution gap.
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: {},
      agentCommand: 'codex',
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("codex '--no-daemon' 'resume' 's1'")
    expect(plan?.launchConfig.agentCommand).toBe('codex')
  })

  it('does not duplicate the flag when resuming a contract-era capture', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: {},
      agentCommand: "codex '--no-daemon'",
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("codex '--no-daemon' 'resume' 's1'")
  })

  it('leaves agents without a contract untouched on resume', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: {},
      agentCommand: 'claude',
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("claude '--resume' 's1'")
  })
})
