import { Menu, Tray, app, nativeImage, shell } from 'electron'
import { appDisplayName } from './dev-instance'
import { trayIconPath } from './tray-icon'
import { trayTooltip, type TrayStatusSink } from './tray-status'

export interface TrayHandle extends TrayStatusSink {
  destroy(): void
}

function buildMenu(onShow: () => void, runningCount: number, productName: string) {
  return Menu.buildFromTemplate([
    { label: trayTooltip(runningCount, productName), enabled: false },
    { type: 'separator' },
    { label: `Show ${productName}`, click: onShow },
    {
      label: 'GitHub',
      click: () => {
        void shell.openExternal('https://github.com/j35dev/Ari')
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
  const productName = appDisplayName(app.isPackaged)
  const iconPath = trayIconPath(
    process.platform,
    app.isPackaged,
    app.getAppPath(),
    process.resourcesPath,
  )
  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) throw new Error(`Ari tray icon could not be loaded from ${iconPath}`)

  // macOS uses the image's logical size for the menu-bar item, not a fixed tray slot.
  const trayIcon = process.platform === 'darwin' ? icon.resize({ width: 18, height: 18 }) : icon
  const tray = new Tray(trayIcon)
  tray.setToolTip(trayTooltip(0, productName))

  tray.setContextMenu(buildMenu(onShow, 0, productName))
  tray.on('click', onShow)

  return {
    destroy: () => tray.destroy(),
    // Menus are immutable once built; rebuilding swaps the status label in.
    setStatus: (runningCount) => {
      tray.setToolTip(trayTooltip(runningCount, productName))
      tray.setContextMenu(buildMenu(onShow, runningCount, productName))
    },
  }
}
