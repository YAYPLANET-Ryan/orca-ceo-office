import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

describe('recovery integration installer provenance', () => {
  const workflow = parse(readFileSync('.github/workflows/pr.yml', 'utf8'))
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? [])
  it('stamps and retains the integration-head installer without publishing the stable feed', () => {
    expect(
      workflow.jobs.package_windows.steps.find((step) => step.uses?.startsWith('actions/checkout'))
        .with.ref
    ).toContain('github.event.pull_request.head.sha')
    for (const name of [
      'Stamp recovery build provenance',
      'Package recovery installer without publishing',
      'Retain verified recovery installer'
    ]) {
      expect(steps.find((step) => step.name === name)?.if).toContain(
        'ryan/session-recovery-integration-'
      )
    }
    const stamp = steps.find((step) => step.name === 'Stamp recovery build provenance')
    expect(stamp.env.RECOVERY_SOURCE_SHA).toContain('github.event.pull_request.head.sha')
    expect(stamp.env.RECOVERY_BUILD_DATE).toContain('20261106')
    expect(stamp.run).toContain('p.orcaRecoverySource=process.env.RECOVERY_SOURCE_SHA')
    expect(
      steps.find((step) => step.name === 'Package recovery installer without publishing').run
    ).toContain('--publish never')
  })
})
