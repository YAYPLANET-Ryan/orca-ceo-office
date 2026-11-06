import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const upstream = 'https://github.com/stablyai/orca.git'
const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

export function resolveHistoricalSkillRef(name, tag, expectedTree, runGit = git) {
  if (!/^[a-z0-9-]+$/.test(name) || !/^v\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(tag)) {
    throw new Error('Invalid historical skill identity')
  }
  if (!/^[a-f0-9]{40}$/.test(expectedTree)) {
    throw new Error('Historical skill tree identity is required')
  }
  const local = `refs/tags/${tag}`
  const historical = `refs/orca-ci/skill-history/${tag}`
  let ref = local
  if (!runGit(['show-ref', '--verify', '--quiet', local], true)) {
    ref = historical
    if (!runGit(['show-ref', '--verify', '--quiet', historical], true)) {
      // Fork tags need not include the releases recorded by the upstream registry.
      runGit(['fetch', '--no-tags', '--no-write-fetch-head', upstream, `refs/tags/${tag}:${ref}`])
    }
  }
  const actual = runGit(['rev-parse', '--verify', `${ref}:skills/${name}`]).trim()
  // A conflicting fork tag is ambiguous; do not silently replace its identity.
  if (actual !== expectedTree) {
    throw new Error(`Historical ${name} at ${tag} does not match its registered tree`)
  }
  return ref
}

function git(args, allowMissing = false) {
  try {
    const result = execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', windowsHide: true })
    return allowMissing ? true : result
  } catch (error) {
    if (allowMissing && error.status === 1) {
      return false
    }
    throw error
  }
}
