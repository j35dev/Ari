import type { DictationTarget } from '../../../../shared/dictation'
import { dictationInsertion, hasDictationText } from '../../../../shared/dictation-format'

type TextInput = HTMLTextAreaElement | HTMLInputElement
const INPUT_TYPES = new Set(['text', 'search', 'url', 'tel'])
const TARGET_DETACHED = 'ari:dictation-target-detached'

function canInsert(input: TextInput): boolean {
  return (
    input.isConnected &&
    !input.matches(':disabled') &&
    !input.readOnly &&
    !input.closest('[hidden], [inert]') &&
    (input.checkVisibility?.({ visibilityProperty: true }) ?? true)
  )
}

/** A cached composer can hide and show again without replacing its textarea. */
export function detachTextTarget(input: HTMLTextAreaElement): void {
  input.dispatchEvent(new Event(TARGET_DETACHED))
}

/** A recording owns one unchanged draft and selection, never the next focused field. */
export function captureTextTarget(
  element: Element | null,
  onFocusLost?: () => void,
): DictationTarget {
  if (!(element instanceof HTMLTextAreaElement) && !(element instanceof HTMLInputElement))
    throw new Error('Focus a text field before dictating.')
  const input: TextInput = element
  if (input instanceof HTMLInputElement && !INPUT_TYPES.has(input.type))
    throw new Error('Dictation is unavailable in this field.')
  if (!canInsert(input)) throw new Error('This text field is unavailable.')
  const value = input.value
  const start = input.selectionStart
  const end = input.selectionEnd
  const session = input.dataset.dictationSession
  if (start === null || end === null) throw new Error('This field does not support text selection.')
  let valid = true
  const invalidate = (): void => {
    valid = false
  }
  const focusLost = (): void => {
    invalidate()
    onFocusLost?.()
  }
  const focus = (event: FocusEvent): void => {
    if (event.target !== input) focusLost()
  }
  input.addEventListener('input', invalidate)
  input.addEventListener('blur', focusLost)
  input.addEventListener(TARGET_DETACHED, focusLost)
  document.addEventListener('focusin', focus)
  window.addEventListener('blur', focusLost)
  const cancel = (): void => {
    valid = false
    input.removeEventListener('input', invalidate)
    input.removeEventListener('blur', focusLost)
    input.removeEventListener(TARGET_DETACHED, focusLost)
    document.removeEventListener('focusin', focus)
    window.removeEventListener('blur', focusLost)
  }
  return {
    cancel,
    insert(text, current = () => true) {
      if (!hasDictationText(text)) {
        cancel()
        return Promise.resolve()
      }
      const available =
        valid &&
        current() &&
        canInsert(input) &&
        (!(input instanceof HTMLInputElement) || INPUT_TYPES.has(input.type)) &&
        input.dataset.dictationSession === session &&
        input.value === value &&
        document.activeElement === input &&
        input.selectionStart === start &&
        input.selectionEnd === end
      cancel()
      if (!available)
        return Promise.reject(
          new Error('The dictation target changed. Dictate again in the intended field.'),
        )
      const before = value.slice(0, start)
      const after = value.slice(end)
      const inserted = dictationInsertion(before, text, after)
      const next = before + inserted + after
      // The native setter lets React's controlled onChange observe this input event.
      const prototype =
        input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, next)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.setSelectionRange(start + inserted.length, start + inserted.length)
      return Promise.resolve()
    },
  }
}

declare global {
  interface Window {
    ariDictation?: {
      capture(id: string): void
      insert(id: string, text: string): Promise<void>
      cancel(id: string): void
    }
  }
}

export function installDictationTarget(): void {
  const targets = new Map<string, DictationTarget>()
  const clear = (): void => {
    for (const target of targets.values()) target.cancel()
    targets.clear()
  }
  // Cancel locally too, in case the native Escape notification and insert IPC cross.
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') clear()
    },
    true,
  )
  window.ariDictation = {
    capture(id) {
      clear()
      targets.set(id, captureTextTarget(document.activeElement))
    },
    async insert(id, text) {
      const target = targets.get(id)
      targets.delete(id)
      if (!target) throw new Error('The dictation target is no longer available.')
      await target.insert(text)
    },
    cancel(id) {
      targets.get(id)?.cancel()
      targets.delete(id)
    },
  }
}
