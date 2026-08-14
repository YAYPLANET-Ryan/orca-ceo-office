import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'

const workflow = parse(readFileSync('.github/workflows/custom-windows-release.yml', 'utf8'))

describe('custom Windows release workflow', () => {
  it('uses the official release build path before packaging', () => {
    const job = workflow.jobs['build-and-publish']
    const buildStep = job.steps.find((step) => step.name === 'Build desktop')

    expect(job['runs-on']).toBe('windows-latest')
    expect(buildStep.run).toBe('pnpm run build:release')
  })

  it('publishes a SHA256 checksum with the Windows installer', () => {
    const job = workflow.jobs['build-and-publish']
    const checksumStep = job.steps.find(
      (step) => step.name === 'Write Windows installer checksum'
    )
    const publishStep = job.steps.find((step) => step.name === 'Publish Windows release')

    expect(checksumStep.run).toContain('Get-FileHash')
    expect(checksumStep.run).toContain('SHA256')
    expect(publishStep.run).toContain('dist/orca-windows-setup.exe.sha256')
  })
})
