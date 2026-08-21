import { Menu, Tray, app, nativeImage } from 'electron'

/**
 * 16x16 base64 PNG: rounded accent square with a dark 'A' notch — a
 * placeholder mark until brand icons land in M14.
 */
const ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9uAAAAKklEQVR4nGNkYGD4z0BFwAri' +
  'YmJiYmJiYmJiYmJiYmJiYmJiYmJiYmIAAL1UA2FbX+yAAAAAAElFTkSuQmCC'

export interface TrayHandle {
  destroy(): void
}

/** System tray with quick actions; tooltip doubles as a status surface. */
export function createTray(onShow: () => void): TrayHandle {
  const tray = new Tray(nativeImage.createFromDataURL(ICON_DATA_URL))
  tray.setToolTip('Ari')

  const menu = Menu.buildFromTemplate([
    { label: 'Show Ari', click: onShow },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
  tray.on('click', onShow)

  return {
    destroy: () => tray.destroy(),
  }
}

export function updateTrayStatus(tray: TrayHandle | null, runningCount: number): void {
  void tray
  void runningCount
  // Live running-count tooltips arrive with turn telemetry (M13).
}
