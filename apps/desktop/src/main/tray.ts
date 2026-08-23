import { Menu, Tray, app, nativeImage } from 'electron'
import { trayTooltip, type TrayStatusSink } from './tray-status'

/**
 * 16x16 base64 PNG: rounded accent square with a dark 'A' notch — a
 * placeholder mark until brand icons land in M14.
 */
const ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9uAAAAKklEQVR4nGNkYGD4z0BFwAri' +
  'YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmIAAL1UA2FbX+yAAAAAAElFTkSuQmCC'

export interface TrayHandle extends TrayStatusSink {
  destroy(): void
}

function buildMenu(onShow: () => void, runningCount: number) {
  return Menu.buildFromTemplate([
    { label: trayTooltip(runningCount), enabled: false },
    { type: 'separator' },
    { label: 'Show Ari', click: onShow },
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
  const tray = new Tray(nativeImage.createFromDataURL(ICON_DATA_URL))
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
