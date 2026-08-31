import { describe, expect, it, vi } from 'vitest'
import { listenOnPreservedPort } from './ws-port-listen'
import type { PreservedPairingPortDeniedError } from './ws-port-listen'

describe('listenOnPreservedPort', () => {
  it('reports an actionable error when the OS denies the preserved port', async () => {
    const cause = Object.assign(new Error('listen EACCES'), {
      code: 'EACCES',
      syscall: 'listen',
      port: 6768
    })

    await expect(
      listenOnPreservedPort({
        port: 6768,
        tryListen: () => Promise.reject(cause)
      })
    ).rejects.toMatchObject({
      name: 'PreservedPairingPortDeniedError',
      code: 'ORCA_PAIRING_PORT_DENIED',
      port: 6768,
      cause
    } satisfies Partial<PreservedPairingPortDeniedError>)
  })

  it('does not reinterpret access failures unrelated to the preserved listen', async () => {
    const cause = Object.assign(new Error('open EACCES'), {
      code: 'EACCES',
      syscall: 'open',
      port: 6768
    })

    await expect(
      listenOnPreservedPort({
        port: 6768,
        tryListen: () => Promise.reject(cause)
      })
    ).rejects.toBe(cause)
  })

  it('retries only the preserved port while an old process still owns it', async () => {
    const occupied = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })
    const tryListen = vi.fn().mockRejectedValueOnce(occupied).mockResolvedValueOnce(undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await listenOnPreservedPort({
        port: 6768,
        retryTimeoutMs: 100,
        retryIntervalMs: 1,
        tryListen
      })
    } finally {
      warn.mockRestore()
    }

    expect(tryListen).toHaveBeenCalledTimes(2)
    expect(tryListen).toHaveBeenNthCalledWith(1, 6768)
    expect(tryListen).toHaveBeenNthCalledWith(2, 6768)
  })
})
