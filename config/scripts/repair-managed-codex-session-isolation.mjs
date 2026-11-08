import { buildSync } from 'esbuild'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

const { values: options } = parseArgs({
  options: {
    check: { type: 'boolean' },
    apply: { type: 'boolean' },
    rollback: { type: 'boolean' },
    'runtime-entry': { type: 'string' },
    'evidence-dir': { type: 'string' },
    'cli-help': { type: 'string' },
    'exclusive-settings-writer': { type: 'boolean' }
  }
})
if ([options.check, options.apply, options.rollback].filter(Boolean).length > 1) {
  throw new Error('Choose exactly one operation.')
}
const mode = options.apply ? 'apply' : options.rollback ? 'rollback' : 'check'
if (mode !== 'check' && !options['exclusive-settings-writer']) {
  throw new Error(
    'Runtime lacks settings compare-and-swap; an exclusive settings writer lease is required.'
  )
}
const runtimeEntry = options['runtime-entry']
const evidenceDir = options['evidence-dir']
if (!runtimeEntry || !evidenceDir) {
  throw new Error('Provide --runtime-entry and --evidence-dir; default mode is read-only --check.')
}
const require = createRequire(import.meta.url)
const { RuntimeClient } = require(resolve(runtimeEntry))
const client = new RuntimeClient()
const status = await client.getCliStatus()
if (
  status.result.target.kind !== 'local' ||
  !status.result.runtime.reachable ||
  typeof status.result.runtime.runtimeId !== 'string' ||
  !status.result.runtime.runtimeId
) {
  throw new Error('A reachable local runtime is required; do not retarget another host.')
}
const settings = (await client.call('settings.get')).result.settings
const before = settings.agentDefaultArgs ?? {}
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])])
        )
      : value
const digest = (value) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex')
const recordPath = resolve(evidenceDir, 'isolation-settings-rollback.json')
let next
if (mode === 'rollback') {
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  if (
    record.hadCodexArgs !== true ||
    typeof record.previousCodexArgs !== 'string' ||
    typeof record.appliedCodexArgs !== 'string'
  ) {
    throw new Error('Rollback record is invalid; keep current settings unchanged.')
  }
  if (record.runtimeId !== status.result.runtime.runtimeId) {
    throw new Error('Runtime changed since repair; revalidate the target before rollback.')
  }
  if (before.codex !== record.appliedCodexArgs) {
    throw new Error('Codex settings changed since repair; rollback will not overwrite them.')
  }
  next = { ...before, codex: record.previousCodexArgs }
} else {
  if (!options['cli-help']) {
    throw new Error('Provide --cli-help from the target host Codex executable.')
  }
  const bundled = buildSync({
    entryPoints: [
      resolve(import.meta.dirname, '../../src/shared/managed-codex-session-isolation.ts')
    ],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false
  }).outputFiles[0].text
  const plan = await import(
    `data:text/javascript;base64,${Buffer.from(bundled).toString('base64')}`
  )
  next = plan.planManagedCodexSessionIsolation({
    cliHelp: readFileSync(options['cli-help'], 'utf8'),
    configuredArgs: before,
    shell: process.platform === 'win32' ? 'powershell' : 'posix'
  })
}
const changed = digest(before) !== digest(next)
if (mode !== 'check' && changed) {
  // The writer flag is an operator attestation; this runtime has no atomic settings CAS.
  const latest = (await client.call('settings.get')).result.settings
  if (digest(latest) !== digest(settings)) {
    throw new Error('Settings changed concurrently; no mutation applied.')
  }
  if (mode === 'apply') {
    mkdirSync(evidenceDir, { recursive: true })
    const record = {
      runtimeId: status.result.runtime.runtimeId,
      hadCodexArgs: Object.hasOwn(before, 'codex'),
      previousCodexArgs: before.codex,
      appliedCodexArgs: next.codex,
      recordedAt: new Date().toISOString()
    }
    if (existsSync(recordPath)) {
      const previousRecord = JSON.parse(readFileSync(recordPath, 'utf8'))
      if (
        previousRecord.runtimeId !== record.runtimeId ||
        previousRecord.previousCodexArgs !== record.previousCodexArgs ||
        previousRecord.appliedCodexArgs !== record.appliedCodexArgs
      ) {
        throw new Error(
          'Existing rollback record belongs to another mutation; keep it and choose a new evidence directory.'
        )
      }
    } else {
      writeFileSync(recordPath, JSON.stringify(record, null, 2), { flag: 'wx' })
    }
  }
  await client.call('settings.update', { agentDefaultArgs: next })
  const after = (await client.call('settings.get')).result.settings
  if (digest(after) !== digest({ ...settings, agentDefaultArgs: next })) {
    throw new Error('Runtime setting readback did not match the requested change.')
  }
}
console.log(
  JSON.stringify({
    mode,
    changed: mode === 'check' ? false : changed,
    repairNeeded: mode === 'check' && changed,
    otherAgentsPreserved: Object.entries(before).every(
      ([agent, value]) => agent === 'codex' || next[agent] === value
    ),
    existingProcessesInterrupted: false
  })
)
