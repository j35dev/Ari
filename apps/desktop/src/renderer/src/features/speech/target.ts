import type { DictationTarget } from '../../../../shared/dictation'

type TextInput = HTMLTextAreaElement | HTMLInputElement
const INPUT_TYPES = new Set(['text', 'search', 'url', 'tel'])

/** A recording owns one unchanged draft and selection, never the next focused field. */
export function captureTextTarget(element: Element | null): DictationTarget {
  if (!(element instanceof HTMLTextAreaElement) && !(element instanceof HTMLInputElement))
    throw new Error('Focus a text field before dictating.')
  const input: TextInput = element
  if (input instanceof HTMLInputElement && !INPUT_TYPES.has(input.type))
    throw new Error('Dictation is unavailable in this field.')
  if (input.disabled || input.readOnly || !input.isConnected)
    throw new Error('This text field is unavailable.')
  const value = input.value
  const start = input.selectionStart
  const end = input.selectionEnd
  const session = input.dataset.dictationSession
  if (start === null || end === null) throw new Error('This field does not support text selection.')
  let valid = true
  const invalidate = (): void => {
    valid = false
  }
  const focus = (event: FocusEvent): void => {
    if (event.target !== input) invalidate()
  }
  input.addEventListener('input', invalidate)
  input.addEventListener('blur', invalidate)
  document.addEventListener('focusin', focus)
  window.addEventListener('blur', invalidate)
  const cancel = (): void => {
    valid = false
    input.removeEventListener('input', invalidate)
    input.removeEventListener('blur', invalidate)
    document.removeEventListener('focusin', focus)
    window.removeEventListener('blur', invalidate)
  }
  return {
    cancel,
    insert(text, current = () => true) {
      if (!text.trim()) {
        cancel()
        return Promise.resolve()
      }
      const available =
        valid &&
        current() &&
        input.isConnected &&
        !input.disabled &&
        !input.readOnly &&
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
      const next = value.slice(0, start) + text + value.slice(end)
      // The native setter lets React's controlled onChange observe this input event.
      const prototype =
        input instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, next)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.setSelectionRange(start + text.length, start + text.length)
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
  window.ariDictation = {
    capture(id) {
      for (const target of targets.values()) target.cancel()
      targets.clear()
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
