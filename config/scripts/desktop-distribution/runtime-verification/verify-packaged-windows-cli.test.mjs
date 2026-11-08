import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { verifyPackagedWindowsCli } = require('./verify-packaged-windows-cli.cjs')
const builder = require('../../../electron-builder.config.cjs')
const assets = ['bin/orca.exe', 'bin/orca.cmd', 'app.asar.unpacked/out/cli/index.js', '../Orca.exe']
const fixtureRoots = []

afterEach(() => {
  for (const root of fixtureRoots.splice(0)) {
    const absoluteRoot = resolve(root)
    if (
      dirname(absoluteRoot) !== resolve(tmpdir()) ||
      !basename(root).startsWith('orca-cli-layout-')
    ) {
      throw new Error('Refusing cleanup outside the disposable CLI layout fixture')
    }
    rmSync(absoluteRoot, { recursive: true, force: true })
  }
})

function fixture({ missing, empty, directory } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-cli-layout-'))
  fixtureRoots.push(root)
  const resourcesDir = join(root, 'resources')
  for (const asset of assets) {
    if (asset === missing) {
      continue
    }
    const file = join(resourcesDir, asset)
    mkdirSync(dirname(file), { recursive: true })
    if (asset === directory) {
      mkdirSync(file)
    } else {
      writeFileSync(file, asset === empty ? '' : 'synthetic layout bytes')
    }
  }
  return resourcesDir
}

describe('packaged Windows CLI layout', () => {
  it('accepts the four nonempty regular files without executing them', () => {
    expect(() => verifyPackagedWindowsCli(fixture(), 'win32')).not.toThrow()
  })

  it.each(assets)('rejects missing %s', (asset) => {
    expect(() => verifyPackagedWindowsCli(fixture({ missing: asset }), 'win32')).toThrow(
      'missing required CLI asset'
    )
  })

  it.each(assets)('rejects empty %s', (asset) => {
    expect(() => verifyPackagedWindowsCli(fixture({ empty: asset }), 'win32')).toThrow(
      'empty or invalid CLI asset'
    )
  })

  it.each(assets)('rejects a directory in place of %s', (asset) => {
    expect(() => verifyPackagedWindowsCli(fixture({ directory: asset }), 'win32')).toThrow(
      'empty or invalid CLI asset'
    )
  })

  it.each(['darwin', 'linux'])('leaves %s packaging independent of Windows files', (platform) => {
    expect(() => verifyPackagedWindowsCli('nonexistent-resources', platform)).not.toThrow()
  })

  it.each([1, 3])(
    'afterPack rejects a missing launcher before runtime probes for arch %s',
    async (arch) => {
      const resourcesDir = fixture({ missing: 'bin/orca.exe' })
      await expect(
        builder.afterPack({
          electronPlatformName: 'win32',
          arch,
          appOutDir: dirname(resourcesDir),
          packager: { appInfo: { productFilename: 'Orca', version: '1.0.0' } }
        })
      ).rejects.toThrow('missing required CLI asset')
    }
  )
})
