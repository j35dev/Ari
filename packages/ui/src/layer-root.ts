/** The element index.html places after #root for every floating surface. */
export const LAYER_ROOT_ID = 'ari-layer-root'

/**
 * Where menus, popovers, scrims, toasts and tooltips portal to: a sibling of
 * the app root, so no pane's stacking context or `overflow` can trap them and
 * their order is decided by the z-index scale alone. Pages without one (tests,
 * other hosts) fall back to `document.body`.
 */
export function layerRoot(): HTMLElement {
  return document.getElementById(LAYER_ROOT_ID) ?? document.body
}
