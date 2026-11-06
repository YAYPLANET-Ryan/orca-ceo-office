import { describe, expect, it, vi } from 'vitest'
import { resolveHistoricalSkillRef } from './skill-update-history.mjs'

const tree = 'a'.repeat(40)
const tag = 'v1.4.178-rc.2'
const local = `refs/tags/${tag}`
const isolated = `refs/orca-ci/skill-history/${tag}`

function fixture(present = [], actual = tree) {
  return vi.fn((args, probe) => (probe ? present.includes(args.at(-1)) : actual))
}

describe('historical skill source contract', () => {
  it('uses an existing release only after verifying its registered tree', () => {
    const git = fixture([local])
    expect(resolveHistoricalSkillRef('orca-cli', tag, tree, git)).toBe(local)
    expect(git.mock.calls.some(([args]) => args[0] === 'fetch')).toBe(false)
  })

  it('fetches missing fork history from upstream into a separate namespace', () => {
    const git = fixture()
    expect(resolveHistoricalSkillRef('orca-cli', tag, tree, git)).toBe(isolated)
    expect(git).toHaveBeenCalledWith([
      'fetch',
      '--no-tags',
      '--no-write-fetch-head',
      'https://github.com/stablyai/orca.git',
      `refs/tags/${tag}:${isolated}`
    ])
  })

  it('reuses the isolated history without refetching or overwriting fork tags', () => {
    const git = fixture([isolated])
    expect(resolveHistoricalSkillRef('orchestration', tag, tree, git)).toBe(isolated)
    expect(git.mock.calls.some(([args]) => args[0] === 'fetch')).toBe(false)
  })

  it('fails closed when a tag has different package contents', () => {
    expect(() =>
      resolveHistoricalSkillRef('orca-cli', tag, tree, fixture([local], 'b'.repeat(40)))
    ).toThrow('does not match its registered tree')
  })

  it('does not turn network failure into a successful historical placement', () => {
    const git = fixture()
    git.mockImplementation((args, probe) => {
      if (probe) {
        return false
      }
      throw new Error('fetch unavailable')
    })
    expect(() => resolveHistoricalSkillRef('orca-cli', tag, tree, git)).toThrow('fetch unavailable')
  })

  it('rejects option-like or path-traversing identities before executing git', () => {
    const git = fixture()
    for (const bad of ['--upload-pack=bad', '../tag', 'v1.2.3;bad']) {
      expect(() => resolveHistoricalSkillRef('orca-cli', bad, tree, git)).toThrow('Invalid')
    }
    expect(git).not.toHaveBeenCalled()
  })
})
