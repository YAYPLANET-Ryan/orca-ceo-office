import { ipcMain, type BrowserWindow } from 'electron'

const channel = 'window:isMaximized'
const owners = new Map<number, { window: BrowserWindow }>()

export function registerWindowMaximizedHandler(window: BrowserWindow): () => void {
  const id = window.webContents.id
  const owner = { window }
  if (owners.size === 0) {
    ipcMain.handle(channel, (event) => {
      const target = owners.get(event.sender.id)?.window
      if (!target || target.isDestroyed() || event.senderFrame !== target.webContents.mainFrame) {
        throw new Error('Unauthorized window IPC sender')
      }
      return target.isMaximized()
    })
  }
  owners.set(id, owner)
  return () => {
    // Why: a late close must not remove a replacement window's registration.
    if (owners.get(id) !== owner) {
      return
    }
    owners.delete(id)
    if (owners.size === 0) {
      ipcMain.removeHandler(channel)
    }
  }
}
