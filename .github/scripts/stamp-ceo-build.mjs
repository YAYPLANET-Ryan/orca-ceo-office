import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
if (!/^[a-f0-9]{40}$/.test(source) || source !== process.env.ORCA_RECOVERY_SOURCE) {
  throw new Error('CEO package checkout differs from the requested source')
}
const run = process.env.GITHUB_RUN_NUMBER
if (!/^\d+$/.test(run ?? '') || Number(run) > 65535) {
  throw new Error('CEO Windows build revision is invalid')
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
if (pkg.version !== '1.4.253') {
  throw new Error('Review the CEO version before updating upstream')
}
const date = new Date().toISOString().slice(0, 10).replaceAll('-', '')
pkg.version = `1.4.253-ceo.${date}.${run}`
pkg.orcaRecoverySource = source
pkg.orcaUpstreamSource = '27eb5e2a6c5017c6fdcba4fee16bf54256550c6f'
pkg.orcaBuildChannel = 'ceo-review'
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`)
console.log(`CEO review package ${pkg.version}, source ${source}`)
