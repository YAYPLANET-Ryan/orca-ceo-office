import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const config = require('../electron-builder.config.cjs')
const { prunePackagedBuildArtifacts } = require('../packaged-runtime-node-modules.cjs')

describe('packaged runtime build artifacts', () => {
  it('excludes artifacts in builder files and prunes copied resources', async () => {
    expect(config.files).toEqual(
      expect.arrayContaining([
        '!**/node_modules/**/build/Release/obj/**',
        '!**/node_modules/**/build/Release/**/*.{tlog,obj,pdb,ilk,exp,lib,iobj,ipdb,lastbuildstate,recipe}',
        '!**/node_modules/**/{test,tests,example,examples,docs,.github}/**'
      ])
    )
    const root = await mkdtemp(join(process.env.TEMP ?? '.', 'orca-build-artifacts-'))
    try {
      const release = join(root, 'node_modules', 'windows-native-registry', 'build', 'Release')
      await mkdir(join(release, 'obj'), { recursive: true })
      await mkdir(join(root, 'node_modules', 'windows-native-registry', 'docs'), {
        recursive: true
      })
      await writeFile(join(release, 'native.node'), 'runtime')
      await writeFile(join(release, 'obj', 'build.obj'), 'artifact')
      prunePackagedBuildArtifacts(root)
      await expect(stat(join(release, 'native.node'))).resolves.toBeTruthy()
      await expect(stat(join(release, 'obj', 'build.obj'))).rejects.toThrow()
      await expect(
        stat(join(root, 'node_modules', 'windows-native-registry', 'docs'))
      ).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
