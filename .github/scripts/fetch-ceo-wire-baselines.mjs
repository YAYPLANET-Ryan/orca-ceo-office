import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pins = JSON.parse(
  readFileSync(new URL('../ceo-wire-baselines.json', import.meta.url), 'utf8')
)
const remote = 'https://github.com/stablyai/orca.git'
const git = (args) => execFileSync('git', args, { encoding: 'utf8', timeout: 180000 }).trim()
const refs = pins.map(({ tag }) => `refs/tags/${tag}`)
const advertised = new Map(
  git(['ls-remote', '--tags', remote, ...refs, ...refs.map((ref) => `${ref}^{}`)])
    .split('\n')
    .map((line) => {
      const [hash, ref] = line.split(/\s+/)
      return [ref, hash]
    })
)
for (const { tag, object, commit } of pins) {
  const ref = `refs/tags/${tag}`
  if (
    !/^v\d+\.\d+\.\d+$/.test(tag) ||
    advertised.get(ref) !== object ||
    (advertised.get(`${ref}^{}`) ?? object) !== commit
  ) {
    throw new Error(`Official wire baseline changed or is missing: ${tag}`)
  }
}
git([
  '-c',
  'maintenance.auto=false',
  '-c',
  'gc.auto=0',
  'fetch',
  '--no-tags',
  '--no-write-fetch-head',
  remote,
  ...refs.map((ref) => `${ref}:${ref}`)
])
for (const { tag, object, commit } of pins) {
  if (
    git(['rev-parse', `refs/tags/${tag}`]) !== object ||
    git(['rev-parse', `refs/tags/${tag}^{commit}`]) !== commit
  ) {
    throw new Error(`Fetched wire baseline differs from the reviewed pin: ${tag}`)
  }
}
console.log(`Verified ${pins.length} official wire baselines without replacing existing tags`)
