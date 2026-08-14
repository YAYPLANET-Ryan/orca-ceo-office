import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const includePath = resolve('config/nsis/daemon-host-uninstall.nsh')

function extractMacro(source, name) {
  const match = source.match(new RegExp(`!macro ${name}\\b([\\s\\S]*?)!macroend`))
  expect(match, `${name} macro must exist`).not.toBeNull()
  return match[1]
}

describe('Windows installer session continuity', () => {
  it('refuses to force-close a running Orca process', async () => {
    const source = await readFile(includePath, 'utf8')
    const check = extractMacro(source, 'customCheckAppRunning')

    expect(check).toContain('nsProcess::FindProcess')
    expect(check).toContain('MB_RETRYCANCEL')
    expect(check).toContain('SetErrorLevel 2')
    expect(check).not.toMatch(/Stop-Process|KillProcess|taskkill|\/F\b/i)
  })

  it('keeps daemon cleanup limited to a real uninstall', async () => {
    const source = await readFile(includePath, 'utf8')
    const uninstall = extractMacro(source, 'customUnInstall')

    expect(uninstall).toContain('${ifNot} ${isUpdated}')
    expect(uninstall).toContain('orca-terminal-daemon.exe')
  })
})
