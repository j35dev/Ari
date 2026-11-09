import { Menu, Tray, app, nativeImage, shell } from 'electron'
import { appDisplayName } from './dev-instance'
import { trayIconPath } from './tray-icon'
import { trayTooltip, type TrayStatusSink } from './tray-status'

export interface TrayHandle extends TrayStatusSink {
  destroy(): void
  isDestroyed(): boolean
  setBackgrounded(backgrounded: boolean): void
}

function buildMenu(
  onShow: () => void,
  runningCount: number,
  productName: string,
  backgrounded: boolean,
) {
  return Menu.buildFromTemplate([
    { label: trayTooltip(runningCount, productName, backgrounded), enabled: false },
    ...(backgrounded
      ? [{ label: `Show ${productName} to return; Quit stops background work`, enabled: false }]
      : []),
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
  let runningCount = 0
  let backgrounded = false
  const refresh = (): void => {
    tray.setToolTip(trayTooltip(runningCount, productName, backgrounded))
    tray.setContextMenu(buildMenu(onShow, runningCount, productName, backgrounded))
  }

  try {
    refresh()
    tray.on('click', onShow)
  } catch (error) {
    tray.destroy()
    throw error
  }

  return {
    destroy: () => tray.destroy(),
    isDestroyed: () => tray.isDestroyed(),
    setBackgrounded: (value) => {
      backgrounded = value
      refresh()
    },
    // Menus are immutable once built; rebuilding swaps the status label in.
    setStatus: (value) => {
      runningCount = value
      refresh()
    },
  }
}
