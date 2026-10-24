import { autoUpdater } from 'electron-updater'
import { BrowserWindow, dialog, ipcMain } from 'electron'
import { isDev, UPDATE_CHANNEL } from './config'

export function setupAutoUpdate(win: BrowserWindow): void {
  if (isDev) return

  // TODO(desktop): This updater flow closes over the first BrowserWindow we
  // receive here. Re-check that update dialogs still target the correct live
  // window after macOS close/reopen cycles.
  autoUpdater.channel = UPDATE_CHANNEL
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[updater] error:', err)
  })

  autoUpdater.on('update-downloaded', async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      message: 'A new version of Pocket Eng is ready.',
      detail: 'Restart to install the update.',
    })
    if (response === 0) autoUpdater.quitAndInstall()
  })

  // Check on startup, and every 2h while the app is running.
  void autoUpdater.checkForUpdatesAndNotify()
  setInterval(() => {
    void autoUpdater.checkForUpdates()
  }, 2 * 60 * 60 * 1000)

  // Manual "Check for Updates…" from the app menu.
  ipcMain.removeHandler('pe:check-for-updates')
  ipcMain.handle('pe:check-for-updates', async () => {
    try {
      await autoUpdater.checkForUpdates()
      return { ok: true }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}
