// @vitest-environment happy-dom
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { ContextIntegrityBanner } from './ContextIntegrityBanner'
import { ContextIntegrityNotice } from './ContextIntegrityNotice'

const fixture = vi.hoisted(
  (): {
    worktreeId: string | null
    target: RuntimeClientTarget | null
    call: ReturnType<typeof vi.fn>
  } => ({
    worktreeId: 'synthetic-workspace',
    target: { kind: 'environment', environmentId: 'owning-server' },
    call: vi.fn()
  })
)
vi.mock('@/store', () => ({
  useAppStore: (select: (state: { activeWorktreeId: string | null }) => unknown) =>
    select({ activeWorktreeId: fixture.worktreeId })
}))
vi.mock('@/runtime/use-worktree-runtime-target', () => ({
  useWorktreeRuntimeTarget: () => fixture.target
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: fixture.call }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
const clean = {
  version: 1,
  unverifiedCount: 0,
  overflowCount: 0,
  durability: 'saved',
  verification: 'available'
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  fixture.worktreeId = 'synthetic-workspace'
  fixture.target = { kind: 'environment', environmentId: 'owning-server' }
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})
async function mount() {
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<ContextIntegrityBanner />)
  })
  return view
}

it('shows the owning remote host refusal without invoking a local fallback', async () => {
  fixture.call.mockResolvedValue({ ...clean, unverifiedCount: 3, durability: 'pending' })
  await mount()
  expect(fixture.call).toHaveBeenCalledWith(
    { kind: 'environment', environmentId: 'owning-server' },
    'diagnostics.contextIntegrity',
    undefined,
    expect.any(Object)
  )
  expect(screen.getByRole('status').getAttribute('data-state')).toBe('refused')
  expect(screen.getByRole('status').getAttribute('data-durability')).toBe('pending')
})

it('keeps the warning on request loss or invalid responses rather than claiming a clean host', async () => {
  fixture.target = { kind: 'local' }
  fixture.call.mockResolvedValue({ ...clean, unverifiedCount: 1 })
  await mount()
  fixture.call.mockRejectedValue(new Error('Host unavailable'))
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  expect(screen.getByRole('status').getAttribute('data-state')).toBe('refused')
  expect(screen.getByRole('status').getAttribute('data-current')).toBe('false')
  fixture.call.mockResolvedValue({ version: 1, unverifiedCount: -1 })
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
  })
  expect(screen.getByRole('status')).toBeTruthy()
})

it('does not let a late reply from a previous host alter the current host warning', async () => {
  let complete!: (value: unknown) => void
  fixture.call.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      })
  )
  const view = await mount()
  fixture.target = { kind: 'environment', environmentId: 'other-owning-server' }
  fixture.call.mockResolvedValue({ ...clean, unverifiedCount: 2 })
  await act(async () => {
    view.rerender(<ContextIntegrityBanner />)
  })
  await act(async () => {
    complete(clean)
  })
  expect(screen.getByRole('status').getAttribute('data-state')).toBe('refused')
})

it('treats an unsupported host as unknown and performs no fallback request', async () => {
  fixture.target = null
  await mount()
  expect(screen.getByRole('status').getAttribute('data-state')).toBe('unavailable')
  expect(fixture.call).not.toHaveBeenCalled()
})

it('distinguishes diagnostic storage failure from a verified empty host', async () => {
  fixture.call.mockResolvedValue({ ...clean, durability: 'unavailable' })
  await mount()
  expect(screen.getByRole('status').getAttribute('data-state')).toBe('storage-unavailable')
  expect(screen.getByRole('status').getAttribute('data-durability')).toBe('unavailable')
})

it('keeps saved diagnostic bytes separate from unavailable ownership verification', async () => {
  fixture.call.mockResolvedValue({ ...clean, verification: 'unavailable' })
  await mount()
  expect(screen.getByRole('status').getAttribute('data-state')).toBe('unavailable')
  expect(screen.getByRole('status').getAttribute('data-durability')).toBe('saved')
})

it('does not treat a missing summary as clean when the caller omits the unavailable flag', async () => {
  await act(async () => {
    render(<ContextIntegrityNotice summary={null} unavailable={false} />)
  })
  expect(screen.getByRole('status').getAttribute('data-state')).toBe('unavailable')
})

it('avoids background polling while hidden and accepts a confirmed empty snapshot', async () => {
  fixture.call.mockResolvedValue(clean)
  const view = await mount()
  expect(screen.queryByRole('status')).toBeNull()
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  fixture.call.mockRejectedValue(new Error('Hidden background request must not run'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
  expect(screen.queryByRole('status')).toBeNull()
  view.unmount()
})
