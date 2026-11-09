import { defaultSpeechShortcut, speechShortcutError } from '@ari/contracts/settings'

export interface HookKey {
  keycode: number
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}

type Modifier = 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'
export interface Chord {
  keycode: number
  modifiers: Record<Modifier, boolean>
  modifierCodes: Record<Modifier, ReadonlySet<number>>
  releases: ReadonlySet<number>
}

export function defaultShortcut(platform: string): string {
  return defaultSpeechShortcut(platform)
}

const modifiersByName: Record<string, Modifier> = {
  ctrl: 'ctrlKey',
  alt: 'altKey',
  shift: 'shiftKey',
  meta: 'metaKey',
}
const modifierNames: Record<Modifier, readonly string[]> = {
  ctrlKey: ['Ctrl', 'CtrlRight'],
  altKey: ['Alt', 'AltRight'],
  shiftKey: ['Shift', 'ShiftRight'],
  metaKey: ['Meta', 'MetaRight'],
}

/** Settings and the widget share one rule for which shortcuts can arm. */
export function shortcutError(shortcut: string, platform: string): string | null {
  return speechShortcutError(shortcut, platform)
}

/** Accept only the shared settings format, never silently arm a different shortcut. */
export function parseChord(
  shortcut: string,
  keys: Record<string, number | string>,
  platform: string,
): Chord | null {
  if (shortcutError(shortcut, platform)) return null
  const parts = shortcut.split('+')
  const key = parts.pop()!
  const names = new Map(Object.entries(keys).map(([name, code]) => [name.toLowerCase(), code]))
  const keycode = names.get(key)
  if (typeof keycode !== 'number') return null
  const modifiers = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }
  for (const part of parts) modifiers[modifiersByName[part]!] = true
  const releases = new Set([keycode])
  const modifierCodes: Record<Modifier, Set<number>> = {
    ctrlKey: new Set(),
    altKey: new Set(),
    shiftKey: new Set(),
    metaKey: new Set(),
  }
  for (const modifier of Object.keys(modifiers) as Modifier[]) {
    for (const name of modifierNames[modifier]) {
      const code = keys[name]
      if (typeof code !== 'number') continue
      modifierCodes[modifier].add(code)
      if (modifiers[modifier]) releases.add(code)
    }
  }
  return { keycode, modifiers, modifierCodes, releases }
}

/**
 * Flags become authoritative per modifier after their first true value.
 * Mixing physical and flag-less injected modifiers in one hook session is unsupported.
 */
export class ChordTracker {
  private held = false
  private primaryDown = false
  private blockedUntilUp = false
  private readonly pressedModifiers = new Set<number>()
  private readonly authoritativeModifiers = new Set<Modifier>()
  private lastPrimaryAt = -Infinity
  private afterReset = false
  constructor(
    private readonly chord: Chord,
    private readonly escape: number,
  ) {}

  reset(now = performance.now()): void {
    this.blockedUntilUp = false
    this.primaryDown = false
    this.held = false
    this.pressedModifiers.clear()
    this.afterReset = true
    this.lastPrimaryAt = now
  }

  private reconcile(event: HookKey): void {
    for (const modifier of Object.keys(this.chord.modifiers) as Modifier[]) {
      if (event[modifier] === true) this.authoritativeModifiers.add(modifier)
      else if (event[modifier] === false && this.authoritativeModifiers.has(modifier)) {
        for (const code of this.chord.modifierCodes[modifier]) this.pressedModifiers.delete(code)
      }
    }
  }

  private pressed(event: HookKey, modifier: Modifier): boolean {
    if (this.authoritativeModifiers.has(modifier)) return event[modifier] === true
    for (const code of this.chord.modifierCodes[modifier]) {
      if (this.pressedModifiers.has(code)) return true
    }
    return false
  }

  private lostRelease(event: HookKey): boolean {
    return Object.entries(this.chord.modifiers).some(
      ([modifier, required]) => required && !this.pressed(event, modifier as Modifier),
    )
  }

  private release(): 'up' {
    this.held = false
    this.blockedUntilUp ||= this.primaryDown
    return 'up'
  }

  down(event: HookKey, now = performance.now(), canStart = true): 'down' | 'cancel' | 'up' | null {
    this.reconcile(event)
    if (Object.values(this.chord.modifierCodes).some((codes) => codes.has(event.keycode)))
      this.pressedModifiers.add(event.keycode)
    if (event.keycode === this.chord.keycode) {
      this.primaryDown = true
      const repeat = this.afterReset && now - this.lastPrimaryAt < 1_000
      this.lastPrimaryAt = now
      if (repeat) return null
      this.afterReset = false
    }
    if (this.held) {
      if (event.keycode === this.escape) return 'cancel'
      return this.lostRelease(event) ? this.release() : null
    }
    if (this.blockedUntilUp || event.keycode !== this.chord.keycode) return null
    if (!canStart) {
      this.blockedUntilUp = true
      return null
    }
    if (
      !Object.entries(this.chord.modifiers).every(
        ([modifier, required]) => this.pressed(event, modifier as Modifier) === required,
      )
    )
      return null
    this.held = true
    return 'down'
  }

  up(event: HookKey): 'up' | null {
    this.pressedModifiers.delete(event.keycode)
    this.reconcile(event)
    if (event.keycode === this.chord.keycode) {
      this.primaryDown = false
      this.blockedUntilUp = false
      this.afterReset = false
      return this.held ? this.release() : null
    }
    if (!this.held) return null
    const modifierReleased =
      this.chord.releases.has(event.keycode) &&
      Object.entries(this.chord.modifierCodes).some(
        ([modifier, codes]) =>
          codes.has(event.keycode) && !this.pressed(event, modifier as Modifier),
      )
    return modifierReleased || this.lostRelease(event) ? this.release() : null
  }
}
