import { vi } from 'vitest'

export type LocalPtyExitCallback = (info: { exitCode: number }) => void
export type LocalPtyMockProcess = {
  onData: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  write: ReturnType<typeof vi.fn>
  resize: ReturnType<typeof vi.fn>
  pause: ReturnType<typeof vi.fn>
  resume: ReturnType<typeof vi.fn>
  kill: ReturnType<typeof vi.fn>
  process: string
  pid: number
}

export function createLocalPtyMockProcess(exitCallback: {
  get: () => LocalPtyExitCallback | undefined
  set: (cb: LocalPtyExitCallback | undefined) => void
}): LocalPtyMockProcess {
  return {
    onData: vi.fn(() => ({ dispose: vi.fn() })),
    onExit: vi.fn((cb: LocalPtyExitCallback) => {
      exitCallback.set(cb)
      return {
        dispose: () => {
          if (exitCallback.get() === cb) {
            exitCallback.set(undefined)
          }
        }
      }
    }),
    write: vi.fn(),
    resize: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    kill: vi.fn(() => {
      exitCallback.get()?.({ exitCode: -1 })
    }),
    process: 'zsh',
    pid: 12345
  }
}
