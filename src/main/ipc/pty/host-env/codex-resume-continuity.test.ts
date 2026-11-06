import { describe, expect, it, vi } from 'vitest'
import {
  noCodexResumeLaunch,
  prepareCodexResumeHome,
  resolveCodexResumeLaunch
} from './codex-resume'

const providerSession = { key: 'session_id' as const, id: 'synthetic-session' }

describe('Codex resume continuity boundaries', () => {
  it.each([
    { connectionId: 'ssh-host', launchAgent: 'codex' as const },
    { launchAgent: 'claude' as const }
  ])('leaves remote and non-Codex launch ownership unchanged: %j', (args) => {
    const prepare = vi.fn()
    expect(
      prepareCodexResumeHome(prepare, { ...args, providerSession, target: { runtime: 'host' } })
    ).toBeNull()
    expect(prepare).not.toHaveBeenCalled()
    expect(noCodexResumeLaunch('agent --resume synthetic-session').command).toBe(
      'agent --resume synthetic-session'
    )
  })

  it.each(['host', 'wsl'] as const)(
    'keeps verified %s resume and its originating home',
    async (runtime) => {
      const result = { outcome: 'resume' as const, codexHomePath: '/synthetic/home' }
      const prepare = vi.fn(async () => result)
      const prepared = prepareCodexResumeHome(prepare, {
        launchAgent: 'codex',
        providerSession,
        target: { runtime }
      })!
      expect(
        await resolveCodexResumeLaunch('codex resume synthetic-session', prepared)
      ).toMatchObject({
        command: 'codex resume synthetic-session',
        codexResumeHome: result
      })
    }
  )

  it.each([null, { outcome: 'fresh' as const, claimedCodexProvenance: false }])(
    'refuses an unresolved local resume: %j',
    async (result) => {
      await expect(
        resolveCodexResumeLaunch('codex resume synthetic-session', {
          providerSession,
          preparation: Promise.resolve(result)
        })
      ).rejects.toThrow(/could not verify/)
    }
  )

  it('preserves authentication failures without relabeling them as provenance failures', async () => {
    await expect(
      resolveCodexResumeLaunch('codex resume synthetic-session', {
        providerSession,
        preparation: Promise.reject(new Error('synthetic auth unavailable'))
      })
    ).rejects.toThrow('synthetic auth unavailable')
  })
})
