import { describe, expect, it } from 'vitest'
import { darwinVersionForMacos } from '../../../../src/shared/macos-darwin-floor.ts'
import { withMinimumSystemVersion } from './gate-mac-update-manifests.mjs'

describe('darwinVersionForMacos', () => {
  it('maps macOS releases to the Darwin version os.release() reports', () => {
    expect(darwinVersionForMacos('12.0')).toBe('21.0.0')
    expect(darwinVersionForMacos('13.0')).toBe('22.0.0')
    expect(darwinVersionForMacos('13.4')).toBe('22.5.0')
    expect(() => darwinVersionForMacos('15.4')).toThrow('no exact Darwin floor')
    expect(darwinVersionForMacos('26.0')).toBe('25.0.0')
    expect(() => darwinVersionForMacos('10.15')).toThrow()
  })
})

describe('withMinimumSystemVersion', () => {
  it('replaces any earlier gate with exactly one top-level entry', () => {
    const manifest =
      'version: 1.5.0\nfiles:\n  - url: Orca-1.5.0-mac.zip\nminimumSystemVersion: 21.0.0\n'
    expect(withMinimumSystemVersion(manifest, '22.0.0')).toBe(
      'version: 1.5.0\nfiles:\n  - url: Orca-1.5.0-mac.zip\nminimumSystemVersion: 22.0.0\n'
    )
  })
})
