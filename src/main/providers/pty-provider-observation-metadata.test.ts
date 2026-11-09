import { expect, it } from 'vitest'
import { readPtyHookContextMetadata } from './pty-hook-context-metadata'
import type { PtyProcessInfo } from './pty-process-info'

it('keeps raw PTY inventory available when an optional observation has an unknown future version', () => {
  const row: PtyProcessInfo = {
    id: 'fixture-pty',
    cwd: '/fixture',
    title: 'shell',
    ownerClientAttached: true
  }
  Reflect.set(row, 'providerObservation', { version: 99 })
  expect(readPtyHookContextMetadata(row)).toEqual({ ownerClientAttached: true })
})

it('does not relax invalid attachment-role metadata while ignoring unreadable observation versions', () => {
  const row: PtyProcessInfo = { id: 'fixture-pty', cwd: '/fixture', title: 'shell' }
  Reflect.set(row, 'ownerClientAttached', 'true')
  Reflect.set(row, 'providerObservation', { version: 99 })
  expect(() => readPtyHookContextMetadata(row)).toThrow('invalid_pty_process_list')
})
