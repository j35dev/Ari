/**
 * Pre-blurred wallpaper. The window pane used to blur the scene live with
 * `backdrop-filter`, which re-filters the whole window on every repaint under
 * it: each streamed token, caret blink, and hover. The scene never changes
 * while it is shown, so it is blurred once here, at the window's size, and
 * wallpaper.css paints the result as a plain background.
 *
 * The bake reproduces the live filter: the scene cover-fitted to the window,
 * mirrored past its edges as the backdrop blur samples it, then
 * `blur(28px) saturate(1.35)`. A blur that wide leaves no detail a quarter
 * of the resolution cannot carry, so the bake is that small and upscales
 * invisibly.
 */

/** The live pane's blur radius in CSS px (wallpaper.css keeps it as the fallback). */
export const WALLPAPER_BLUR_PX = 28

/** The live pane's saturation boost. */
export const WALLPAPER_SATURATE = 1.35

/** Bake resolution relative to the window. */
export const BAKE_SCALE = 1 / 4

/** How long a resize must settle before the bake is redone at the new size. */
export const RESIZE_SETTLE_MS = 150

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Where `background-size: cover; background-position: center` puts an image. */
export function coverRect(
  imageWidth: number,
  imageHeight: number,
  boxWidth: number,
  boxHeight: number,
): Rect {
  const scale = Math.max(boxWidth / imageWidth, boxHeight / imageHeight)
  const width = imageWidth * scale
  const height = imageHeight * scale
  return { x: (boxWidth - width) / 2, y: (boxHeight - height) / 2, width, height }
}

export interface BakePlan {
  /** Bake size in canvas px. */
  width: number
  height: number
  /** Blur radius in canvas px. */
  blur: number
  /** Mirrored border wide enough that the blur never samples past it. */
  margin: number
}

export function bakePlan(viewWidth: number, viewHeight: number): BakePlan {
  const blur = WALLPAPER_BLUR_PX * BAKE_SCALE
  return {
    width: Math.max(1, Math.round(viewWidth * BAKE_SCALE)),
    height: Math.max(1, Math.round(viewHeight * BAKE_SCALE)),
    blur,
    margin: Math.ceil(blur * 3),
  }
}

/** Whether this engine can bake; without it the live blur stays in place. */
export function canBakeWallpaper(): boolean {
  return typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function'
}

function context2d(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('2D canvas unavailable')
  return context
}

/**
 * Blurs the scene at `src` for a `viewWidth`×`viewHeight` window and resolves
 * to an object URL that is already decoded, so swapping it in never shows a
 * blank frame. The caller owns the URL and revokes it.
 */
export async function bakeWallpaper(src: string, viewWidth: number, viewHeight: number): Promise<string> {
  const response = await fetch(src)
  if (!response.ok) throw new Error(`wallpaper fetch failed: ${response.status}`)
  const bitmap = await createImageBitmap(await response.blob())
  const { width, height, blur, margin } = bakePlan(viewWidth, viewHeight)

  const scene = new OffscreenCanvas(width, height)
  const fit = coverRect(bitmap.width, bitmap.height, width, height)
  context2d(scene).drawImage(bitmap, fit.x, fit.y, fit.width, fit.height)
  bitmap.close()

  // Nine tiles: the scene in the middle, mirror images around it, so the
  // blur near each edge averages scene rather than transparency.
  const padded = new OffscreenCanvas(width + 2 * margin, height + 2 * margin)
  const paddedContext = context2d(padded)
  for (const fx of [-1, 0, 1]) {
    for (const fy of [-1, 0, 1]) {
      paddedContext.setTransform(
        fx === 0 ? 1 : -1,
        0,
        0,
        fy === 0 ? 1 : -1,
        fx === 1 ? margin + 2 * width : margin,
        fy === 1 ? margin + 2 * height : margin,
      )
      paddedContext.drawImage(scene, 0, 0)
    }
  }

  const out = new OffscreenCanvas(width, height)
  const outContext = context2d(out)
  outContext.filter = `blur(${blur}px) saturate(${WALLPAPER_SATURATE})`
  outContext.drawImage(padded, -margin, -margin)
  const url = URL.createObjectURL(await out.convertToBlob({ type: 'image/png' }))
  try {
    const image = new Image()
    image.src = url
    await image.decode()
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
  return url
}

export interface WallpaperBakeDeps {
  bake?: (src: string, viewWidth: number, viewHeight: number) => Promise<string>
  revoke?: (url: string) => void
}

/**
 * Keeps a baked copy of the scene at `src` on `root` as `--ari-wallpaper-baked`
 * (flagged by `data-ari-wallpaper-baked`) and re-bakes after the window
 * settles at a new size. Until a bake lands, or if baking fails, the flag is
 * absent and wallpaper.css falls back to the live blur. Returns the teardown.
 */
export function installWallpaperBake(
  root: HTMLElement,
  src: string,
  { bake = bakeWallpaper, revoke = (url) => URL.revokeObjectURL(url) }: WallpaperBakeDeps = {},
): () => void {
  let disposed = false
  let current: string | null = null
  let bakedSize = ''
  let generation = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  const clear = (): void => {
    delete root.dataset['ariWallpaperBaked']
    root.style.removeProperty('--ari-wallpaper-baked')
    if (current !== null) revoke(current)
    current = null
  }

  const run = (): void => {
    const width = window.innerWidth
    const height = window.innerHeight
    const size = `${width}x${height}`
    if (size === bakedSize) return
    bakedSize = size
    const mine = ++generation
    bake(src, width, height).then(
      (url) => {
        if (disposed || mine !== generation) {
          revoke(url)
          return
        }
        const previous = current
        current = url
        root.style.setProperty('--ari-wallpaper-baked', `url("${url}")`)
        root.dataset['ariWallpaperBaked'] = ''
        if (previous !== null) revoke(previous)
      },
      (error: unknown) => {
        if (disposed || mine !== generation) return
        console.warn('[ari] wallpaper bake failed; keeping the live blur', error)
        bakedSize = ''
        clear()
      },
    )
  }

  const onResize = (): void => {
    clearTimeout(timer)
    timer = setTimeout(run, RESIZE_SETTLE_MS)
  }

  run()
  window.addEventListener('resize', onResize)
  return () => {
    disposed = true
    clearTimeout(timer)
    window.removeEventListener('resize', onResize)
    clear()
  }
}
