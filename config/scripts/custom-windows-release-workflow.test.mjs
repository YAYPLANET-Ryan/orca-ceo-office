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
})
