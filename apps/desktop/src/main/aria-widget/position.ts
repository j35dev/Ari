export interface Rectangle {
  x: number
  y: number
  width: number
  height: number
}

export const WIDGET_WIDTH = 380
export const WIDGET_HEIGHT = 72

/** Electron work areas are DIP coordinates and already exclude the taskbar or dock. */
export function widgetBounds(workArea: Rectangle): Rectangle {
  const width = Math.min(WIDGET_WIDTH, workArea.width)
  const height = Math.min(WIDGET_HEIGHT, workArea.height)
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(Math.max(workArea.y, workArea.y + workArea.height - height - 12)),
    width,
    height,
  }
}
