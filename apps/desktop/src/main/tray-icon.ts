import { join } from 'node:path'

/** Resolves the branded tray asset in development and packaged applications. */
export function trayIconPath(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  appPath: string,
  resourcesPath: string,
): string {
  const fileName = platform === 'win32' ? 'icon.ico' : 'icon.png'
  return isPackaged ? join(resourcesPath, fileName) : join(appPath, 'build', fileName)
}
