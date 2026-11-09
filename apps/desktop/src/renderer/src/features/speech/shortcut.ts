import { speechShortcutError } from '@ari/contracts/settings'

type ShortcutKey = Pick<
  KeyboardEvent,
  'code' | 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'
>

const keyNames: Record<string, string> = {
  Space: 'space',
  Enter: 'enter',
  Tab: 'tab',
  Delete: 'delete',
  Comma: 'comma',
  Period: 'period',
  Slash: 'slash',
  Semicolon: 'semicolon',
  Quote: 'quote',
  Backquote: 'backquote',
  Minus: 'minus',
  Equal: 'equal',
  BracketLeft: 'bracketleft',
  BracketRight: 'bracketright',
  Backslash: 'backslash',
}

export function isShortcutModifier(key: string): boolean {
  return ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(key)
}

export function shortcutFromKey(
  event: ShortcutKey,
  platform: string,
): { shortcut: string } | { error: string } | null {
  if (isShortcutModifier(event.key)) return null
  const key = /^Key[A-Z]$/.test(event.code)
    ? event.code.slice(3).toLowerCase()
    : /^Digit[0-9]$/.test(event.code)
      ? event.code.slice(5)
      : /^F([1-9]|1[0-9]|2[0-4])$/.test(event.code)
        ? event.code.toLowerCase()
        : keyNames[event.code]
  if (!key) return { error: 'Use a letter, number, punctuation key, Space, Enter, or F1–F24.' }
  const shortcut = [
    ...(event.ctrlKey ? ['ctrl'] : []),
    ...(event.altKey ? ['alt'] : []),
    ...(event.shiftKey ? ['shift'] : []),
    ...(event.metaKey ? ['meta'] : []),
    key,
  ].join('+')
  const error = speechShortcutError(shortcut, platform)
  return error ? { error } : { shortcut }
}
