'use strict'

const { statSync } = require('node:fs')
const { join } = require('node:path')

function verifyPackagedWindowsCli(resourcesDir, platform) {
  if (platform !== 'win32') {
    return
  }

  // Missing extraResources can leave a valid-looking shim without its native launcher.
  for (const parts of [
    ['bin', 'orca.exe'],
    ['bin', 'orca.cmd'],
    ['app.asar.unpacked', 'out', 'cli', 'index.js'],
    ['..', 'Orca.exe']
  ]) {
    const file = join(resourcesDir, ...parts)
    let metadata
    try {
      metadata = statSync(file)
    } catch (error) {
      throw new Error(`[verify-packaged-windows-cli] missing required CLI asset: ${file}`, {
        cause: error
      })
    }
    if (!metadata.isFile() || metadata.size === 0) {
      throw new Error(`[verify-packaged-windows-cli] empty or invalid CLI asset: ${file}`)
    }
  }
}

module.exports = { verifyPackagedWindowsCli }
