/** True when the event landed in something that owns the text the user is typing. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * True when the event landed in, or inside, something that brings its own
 * context menu — a text field's spellcheck menu, a transcript's code block, or
 * any element that opted out with `data-native-context-menu`. Ancestors count,
 * because the target of a right-click deep inside a transcript is usually a
 * `<span>` rather than the editable element itself.
 */
export function ownsContextMenu(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (isEditableTarget(target)) return true
  return (
    target.closest(
      'input, textarea, select, [contenteditable="true"], [data-native-context-menu]',
    ) !== null
  )
}
