import { Menu, Tray, app, nativeImage, shell } from 'electron'
import { trayIconPath } from './tray-icon'
import { trayTooltip, type TrayStatusSink } from './tray-status'

export interface TrayHandle extends TrayStatusSink {
  destroy(): void
}

function buildMenu(onShow: () => void, runningCount: number) {
  return Menu.buildFromTemplate([
    { label: trayTooltip(runningCount), enabled: false },
    { type: 'separator' },
    { label: 'Show Ari', click: onShow },
    {
      label: 'GitHub',
      click: () => {
        void shell.openExternal('https://github.com/tahacore/Ari')
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit()
      },
    },
  ])
}

/** System tray with quick actions; tooltip doubles as a status surface. */
export function createTray(onShow: () => void): TrayHandle {
  const iconPath = trayIconPath(
    process.platform,
    app.isPackaged,
    app.getAppPath(),
    process.resourcesPath,
  )
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) throw new Error(`Ari tray icon could not be loaded from ${iconPath}`)

  const tray = new Tray(icon)
  tray.setToolTip(trayTooltip(0))

  tray.setContextMenu(buildMenu(onShow, 0))
  tray.on('click', onShow)

  return {
    destroy: () => tray.destroy(),
    // Menus are immutable once built; rebuilding swaps the status label in.
    setStatus: (runningCount) => {
      tray.setToolTip(trayTooltip(runningCount))
      tray.setContextMenu(buildMenu(onShow, runningCount))
    },
  }
}
