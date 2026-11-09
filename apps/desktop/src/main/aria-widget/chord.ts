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
  return platform === 'darwin' ? 'ctrl+alt+space' : 'ctrl+space'
}

const aliases: Record<string, Modifier> = {
  ctrl: 'ctrlKey',
  control: 'ctrlKey',
  alt: 'altKey',
  option: 'altKey',
  shift: 'shiftKey',
  meta: 'metaKey',
  cmd: 'metaKey',
  command: 'metaKey',
  super: 'metaKey',
}

const modifierNames: Record<Modifier, readonly string[]> = {
  ctrlKey: ['Ctrl', 'CtrlRight'],
  altKey: ['Alt', 'AltRight'],
  shiftKey: ['Shift', 'ShiftRight'],
  metaKey: ['Meta', 'MetaRight'],
}

/** Accept settings accelerators, never silently arm a different shortcut. */
export function parseChord(
  shortcut: string,
  keys: Record<string, number | string>,
  platform: string,
): Chord | null {
  const modifiers = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }
  let keycode: number | undefined
  const names = new Map(Object.entries(keys).map(([name, code]) => [name.toLowerCase(), code]))
  for (const raw of shortcut.toLowerCase().split('+')) {
    const part = raw.trim()
    const modifier =
      part === 'cmdorctrl' || part === 'commandorcontrol'
        ? platform === 'darwin'
          ? 'metaKey'
          : 'ctrlKey'
        : aliases[part]
    if (modifier) {
      if (modifiers[modifier]) return null
      modifiers[modifier] = true
    } else {
      const keyName = part === 'esc' ? 'escape' : part
      const code = names.get(keyName)
      if (keycode !== undefined || typeof code !== 'number' || keyName === 'escape') return null
      if (
        Object.values(modifierNames)
          .flat()
          .some((name) => name.toLowerCase() === part)
      )
        return null
      keycode = code
    }
  }
  if (keycode === undefined || !Object.values(modifiers).some(Boolean)) return null
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

export class ChordTracker {
  private held = false
  private readonly pressedModifiers = new Set<number>()
  constructor(
    private readonly chord: Chord,
    private readonly escape: number,
  ) {}

  reset(): void {
    this.held = false
    this.pressedModifiers.clear()
  }

  private reconcile(event: HookKey): void {
    for (const modifier of Object.keys(this.chord.modifiers) as Modifier[]) {
      if (event[modifier] !== false) continue
      for (const code of this.chord.modifierCodes[modifier]) this.pressedModifiers.delete(code)
    }
  }

  down(event: HookKey): 'down' | 'cancel' | null {
    this.reconcile(event)
    if (Object.values(this.chord.modifierCodes).some((codes) => codes.has(event.keycode)))
      this.pressedModifiers.add(event.keycode)
    if (this.held) return event.keycode === this.escape ? 'cancel' : null
    if (event.keycode !== this.chord.keycode) return null
    // Flags reconcile releases missed while Windows locks or changes privilege.
    // Tracking is only a fallback for event sources that omit modifier flags.
    if (
      !Object.entries(this.chord.modifiers).every(([key, value]) => {
        const modifier = key as Modifier
        const pressed =
          event[modifier] ??
          [...this.chord.modifierCodes[modifier]].some((code) => this.pressedModifiers.has(code))
        return pressed === value
      })
    )
      return null
    this.held = true
    return 'down'
  }

  up(event: HookKey): 'up' | null {
    this.reconcile(event)
    this.pressedModifiers.delete(event.keycode)
    if (!this.held || !this.chord.releases.has(event.keycode)) return null
    if (
      event.keycode !== this.chord.keycode &&
      Object.entries(this.chord.modifierCodes).some(
        ([modifier, codes]) =>
          codes.has(event.keycode) &&
          (event[modifier as Modifier] ??
            [...codes].some((code) => this.pressedModifiers.has(code))),
      )
    )
      return null
    this.held = false
    return 'up'
  }
}
