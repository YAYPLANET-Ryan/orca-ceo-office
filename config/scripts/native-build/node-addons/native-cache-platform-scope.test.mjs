import { describe, expect, it } from 'vitest'
import { nativeCachePlatformScope } from './native-cache-platform-scope.mjs'

describe('native cache platform scope', () => {
  it.each([
    ['ID=ubuntu\nVERSION_ID="20.04"', 'ubuntu-20.04'],
    ['ID=ubuntu\nVERSION_ID="24.04"', 'ubuntu-24.04'],
    ['ID=debian\nVERSION_ID="12"', 'debian-12']
  ])('separates known Linux distributions and versions: %s', (release, expected) => {
    expect(nativeCachePlatformScope('Linux', 'ubuntu24', release)).toBe(expected)
  })

  it.each([
    undefined,
    '',
    'ID=ubuntu',
    'VERSION_ID=24.04',
    'ID=\nVERSION_ID=24.04',
    'ID=ubuntu\nVERSION_ID=""'
  ])('refuses unknown Linux scope: %s', (release) => {
    expect(() => nativeCachePlatformScope('Linux', 'ubuntu24', release)).toThrow(
      'requires a known os-release'
    )
  })

  it.each([
    ['Windows', 'win22', 'win22'],
    ['macOS', 'macos15', 'macos15'],
    ['Windows', undefined, 'Windows']
  ])('preserves non-Linux runner scope: %s', (runnerOS, imageOS, expected) => {
    expect(nativeCachePlatformScope(runnerOS, imageOS)).toBe(expected)
  })
})
