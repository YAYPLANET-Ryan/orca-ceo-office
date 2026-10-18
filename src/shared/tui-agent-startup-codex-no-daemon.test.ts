import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan, buildAgentStartupPlan } from './tui-agent-startup'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { applyAgentLaunchArgsToCustomCommand } from './tui-agent-launch-command'

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
      platform: 'win32',
      shell: 'posix'
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
      platform: 'win32',
      shell: 'posix'
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
      platform: 'win32',
      shell: 'posix'
    })

    expect(plan?.launchCommand).toBe("codex '--no-daemon' 'resume' 's1'")
  })

  it('places the flag before a -- terminator in a Codex override', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: { codex: 'codex --profile work --' },
      platform: 'win32',
      shell: 'posix',
      allowEmptyPromptLaunch: true
    })

    expect(plan?.launchCommand).toBe("codex '--no-daemon' --profile work --")
  })

  it('does not count a flag that sits after the terminator as present', () => {
    // Why: `codex -- --no-daemon` hands the flag to Codex as a positional prompt.
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: { codex: 'codex -- --no-daemon' },
      platform: 'win32',
      shell: 'posix',
      allowEmptyPromptLaunch: true
    })

    expect(plan?.launchCommand).toBe("codex '--no-daemon' -- --no-daemon")
  })

  it('anchors the terminator search on the agent executable, not a wrapper', () => {
    const wrapped = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: { codex: 'env -- codex' },
      platform: 'win32',
      shell: 'posix',
      allowEmptyPromptLaunch: true
    })
    const unreachable = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: { codex: 'bash -c codex -- x' },
      platform: 'win32',
      shell: 'posix',
      allowEmptyPromptLaunch: true
    })

    // Why: `--` before the executable belongs to env; the flag goes after codex.
    expect(wrapped?.launchCommand).toBe("env -- codex '--no-daemon'")
    // Why: codex is bash's -c script here; the flag lands as the script's $0 and
    // never reaches codex, which is harmless. Only remoting wrappers are refused.
    expect(unreachable?.launchCommand).toBe("bash -c codex '--no-daemon' -- x")
  })

  it('applies the contract through the PowerShell call operator', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: { codex: "& 'codex' --profile work --" },
      platform: 'win32',
      shell: 'powershell',
      allowEmptyPromptLaunch: true
    })

    expect(plan?.launchCommand).toBe("& 'codex' '--no-daemon' --profile work --")
  })

  it('falls back to appending when a cmd.exe token diverges from the shell parse', () => {
    // Why: a cmd token with a lone single quote is not modelled by the tokenizer; splicing could cut live syntax.
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: { codex: "codex --profile it's --" },
      platform: 'win32',
      shell: 'cmd',
      allowEmptyPromptLaunch: true
    })

    expect(plan?.launchCommand).toBe('codex --profile it\'s -- "--no-daemon"')
  })

  it('leaves WSL and other non-Windows host launches without the flag', () => {
    // Why: a Linux platform on this build means WSL or another host whose Codex version is not pinned.
    const launch = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux'
    })
    const resume = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: {},
      agentCommand: 'codex',
      platform: 'linux'
    })

    expect(launch?.launchCommand).toBe("codex 'fix it'")
    expect(resume?.launchCommand).toBe("codex 'resume' 's1'")
  })

  it('leaves remote Codex launches and resumes without the flag', () => {
    // Why: the remote CLI version is unknown; an unsupported flag would block startup.
    const launch = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'win32',
      shell: 'posix',
      isRemote: true
    })
    const resume = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: {},
      platform: 'win32',
      shell: 'posix',
      isRemote: true
    })

    expect(launch?.launchCommand).toBe("codex 'fix it'")
    expect(resume?.launchCommand).toBe("codex 'resume' 's1'")
  })

  it('treats a terminator positional like `codex -- wsl` as data, not a wrapper', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: { codex: 'codex -- wsl' },
      platform: 'win32',
      shell: 'posix',
      allowEmptyPromptLaunch: true
    })

    expect(plan?.launchCommand).toBe("codex '--no-daemon' -- wsl")
  })

  it('reaches Codex behind a local shell wrapper but not behind a remoting one', () => {
    const host = { platform: 'win32' as const }
    expect(applyAgentLaunchArgsToCustomCommand('cmd /c codex --', 'powershell', host)).toBe(
      "cmd /c codex '--no-daemon' --"
    )
    expect(
      applyAgentLaunchArgsToCustomCommand('powershell -Command codex', 'powershell', host)
    ).toBe("powershell -Command codex '--no-daemon'")
    expect(applyAgentLaunchArgsToCustomCommand('cmd /c wsl codex', 'powershell', host)).toBe(
      'cmd /c wsl codex'
    )
  })

  it('never follows a remoting wrapper such as wsl or ssh', () => {
    const wsl = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: { codex: 'wsl codex' },
      platform: 'win32',
      shell: 'posix',
      allowEmptyPromptLaunch: true
    })
    const ssh = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: { codex: 'ssh devbox codex' },
      platform: 'win32',
      shell: 'posix',
      allowEmptyPromptLaunch: true
    })

    expect(wsl?.launchCommand).toBe('wsl codex')
    expect(ssh?.launchCommand).toBe('ssh devbox codex')
  })

  it('applies the contract to user-authored Codex commands on a native Windows host only', () => {
    const host = { platform: 'win32' as const }
    expect(applyAgentLaunchArgsToCustomCommand('codex --model gpt-5.5', 'powershell', host)).toBe(
      "codex '--no-daemon' --model gpt-5.5"
    )
    expect(applyAgentLaunchArgsToCustomCommand('codex exec -m x "do it"', 'cmd', host)).toBe(
      'codex "--no-daemon" exec -m x "do it"'
    )
    expect(applyAgentLaunchArgsToCustomCommand("codex 'resume' 'abc'", 'posix', host)).toBe(
      "codex '--no-daemon' 'resume' 'abc'"
    )
    // untouched: other agents, wrappers, already present, remote/linux hosts
    expect(applyAgentLaunchArgsToCustomCommand('claude --resume abc', 'powershell', host)).toBe(
      'claude --resume abc'
    )
    expect(applyAgentLaunchArgsToCustomCommand('wsl codex', 'powershell', host)).toBe('wsl codex')
    expect(applyAgentLaunchArgsToCustomCommand('codex --no-daemon', 'powershell', host)).toBe(
      'codex --no-daemon'
    )
    expect(
      applyAgentLaunchArgsToCustomCommand('codex', 'powershell', {
        platform: 'win32',
        isRemote: true
      })
    ).toBe('codex')
    expect(applyAgentLaunchArgsToCustomCommand('codex', 'posix', { platform: 'linux' })).toBe(
      'codex'
    )
  })

  it('leaves agents without a contract untouched on resume', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: {},
      agentCommand: 'claude',
      platform: 'win32',
      shell: 'posix'
    })

    expect(plan?.launchCommand).toBe("claude '--resume' 's1'")
  })
})
