import { describe, expect, it } from 'vitest'
import { parseCeoOfficeManifest } from './ceo-office-manifest'

describe('parseCeoOfficeManifest', () => {
  it('accepts a safe manifest', () => {
    expect(
      parseCeoOfficeManifest({
        version: 1,
        title: 'CEO Office',
        groups: [
          {
            id: 'businesses',
            label: 'Businesses',
            items: [{ id: 'oil', label: 'OilDealer', path: '02_BUSINESSES/oildealer' }]
          }
        ]
      })
    ).toMatchObject({
      title: 'CEO Office',
      groups: [{ items: [{ path: '02_BUSINESSES/oildealer' }] }]
    })
  })

  it('rejects absolute and parent-traversal paths', () => {
    for (const path of ['E:/secret', '/secret', '../secret', '02_BUSINESSES/../secret']) {
      expect(
        parseCeoOfficeManifest({
          version: 1,
          title: 'CEO Office',
          groups: [{ id: 'x', label: 'X', items: [{ id: 'x', label: 'X', path }] }]
        })
      ).toBeNull()
    }
  })

  it('rejects malformed groups', () => {
    expect(
      parseCeoOfficeManifest({ version: 1, title: 'CEO Office', groups: [{ id: 'x' }] })
    ).toBeNull()
  })
})
