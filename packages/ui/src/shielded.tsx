import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * The host takes no document style: an inline `!important` declaration beats every
 * stylesheet rule, so nothing a theme sets on the host or its ancestors inherits in.
 * `all` leaves out direction and unicode-bidi, which would reorder a row.
 */
const HOST_STYLE =
  'all:initial !important;display:contents !important;direction:ltr !important;unicode-bidi:isolate !important'
/** A theme can still give the host ::before/::after; inner `!important` wins over outer. */
const HOST_SHEET =
  ':host{all:initial !important;display:contents !important}:host::before,:host::after{content:none !important;display:none !important}'

/**
 * Renders `children` in a shadow root that theme CSS cannot restyle, for controls a
 * theme must never relabel, reorder or hide: document selectors do not match inside a
 * shadow tree. `css` styles the content. It must not read `var(--…)` (custom properties
 * still inherit in) or name a font family (theme `@font-face` rules can claim any
 * name); generic families such as `system-ui` cannot be claimed.
 */
export function Shielded({ css, children }: { css: string; children: ReactNode }) {
  const [root, setRoot] = useState<ShadowRoot | null>(null)
  const attach = useCallback((host: HTMLDivElement | null) => {
    if (!host) return
    host.setAttribute('style', HOST_STYLE)
    setRoot(host.shadowRoot ?? host.attachShadow({ mode: 'open' }))
  }, [])
  return (
    <div ref={attach} data-ari-shield="">
      {root &&
        createPortal(
          <>
            <style>{HOST_SHEET + css}</style>
            {children}
          </>,
          root,
        )}
    </div>
  )
}
