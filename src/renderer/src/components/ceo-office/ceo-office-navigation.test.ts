import { describe, expect, it } from 'vitest'
import { resolveCeoOfficeNavigation } from './ceo-office-navigation'

const LOCAL = { itemPath: 'E:/ORCA/02_BUSINESSES/oildealer' }

describe('resolveCeoOfficeNavigation', () => {
  // The regression this guards: every local workspace fell through to a throw, so
  // clicking a catalog entry did nothing and the failure was swallowed by the
  // caller's .catch(). A local click must give the entry its own workspace.
  it('opens the entry as a folder workspace on a local workspace', () => {
    expect(resolveCeoOfficeNavigation(LOCAL)).toEqual({
      kind: 'folder-workspace',
      folderPath: 'E:/ORCA/02_BUSINESSES/oildealer'
    })
  })

  it.each([
    { name: 'no connection id', connectionId: undefined, activePtyId: 'ssh:host-1@@abc' },
    { name: 'no active pty', connectionId: 'host-1', activePtyId: undefined },
    { name: 'active pty is local', connectionId: 'host-1', activePtyId: 'repo-1::E:/ORCA@@abc' },
    {
      name: 'active pty belongs to another host',
      connectionId: 'host-1',
      activePtyId: 'ssh:host-2@@abc'
    }
  ])(
    'falls back to a folder workspace when the SSH terminal does not match: $name',
    ({ connectionId, activePtyId }) => {
      expect(resolveCeoOfficeNavigation({ ...LOCAL, connectionId, activePtyId })).toMatchObject({
        kind: 'folder-workspace'
      })
    }
  )

  it('moves the matching SSH terminal instead of registering a remote path locally', () => {
    expect(
      resolveCeoOfficeNavigation({
        itemPath: '/srv/orca/02_BUSINESSES/oildealer',
        connectionId: 'host-1',
        activePtyId: 'ssh:host-1@@abc'
      })
    ).toEqual({
      kind: 'ssh-cd',
      ptyId: 'ssh:host-1@@abc',
      command: "Set-Location -LiteralPath '/srv/orca/02_BUSINESSES/oildealer'\r"
    })
  })

  // 05_REVIEW has no folder on disk and failed with a toast; 05_APPROVED does have
  // one and would quietly become a project sitting beside the businesses.
  it.each([
    { name: 'local', connectionId: undefined, activePtyId: undefined },
    { name: 'with a matching SSH terminal', connectionId: 'host-1', activePtyId: 'ssh:host-1@@abc' }
  ])('does nothing for a section entry: $name', ({ connectionId, activePtyId }) => {
    expect(
      resolveCeoOfficeNavigation({
        itemPath: 'E:/ORCA/05_APPROVED',
        itemKind: 'section',
        connectionId,
        activePtyId
      })
    ).toEqual({ kind: 'none' })
  })

  it.each([{ kind: 'folder' as const }, { kind: 'task' as const }, { kind: undefined }])(
    'still opens a workspace for kind $kind',
    ({ kind }) => {
      expect(resolveCeoOfficeNavigation({ ...LOCAL, itemKind: kind })).toMatchObject({
        kind: 'folder-workspace'
      })
    }
  )

  it('doubles single quotes so a quote in a path cannot end the literal string', () => {
    expect(
      resolveCeoOfficeNavigation({
        itemPath: "/srv/o'rca/biz",
        connectionId: 'host-1',
        activePtyId: 'ssh:host-1@@abc'
      })
    ).toMatchObject({ command: "Set-Location -LiteralPath '/srv/o''rca/biz'\r" })
  })
})
