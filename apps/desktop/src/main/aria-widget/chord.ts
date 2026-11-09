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
  return platform === 'darwin' ? 'alt-right' : 'ctrl+space'
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
    const side = /^(ctrl|alt|shift|meta)-(left|right)$/.exec(part)
    if (side) {
      const modifier = aliases[side[1]!]!
      const name = modifierNames[modifier][side[2] === 'right' ? 1 : 0]!
      const code = keys[name]
      if (keycode !== undefined || modifiers[modifier] || typeof code !== 'number') return null
      keycode = code
      modifiers[modifier] = true
      continue
    }
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
  private primaryDown = false
  private blockedUntilUp = false
  private readonly pressedModifiers = new Set<number>()
  private readonly maskedModifiers = new Set<Modifier>()
  constructor(
    private readonly chord: Chord,
    private readonly escape: number,
  ) {}

  reset(): void {
    this.blockedUntilUp ||= this.primaryDown
    this.held = false
    this.pressedModifiers.clear()
    this.maskedModifiers.clear()
  }

  private pressed(event: HookKey, modifier: Modifier): boolean {
    // Generic SendInput modifiers have key events but no libuiohook mask bit.
    return (
      event[modifier] === true ||
      [...this.chord.modifierCodes[modifier]].some((code) => this.pressedModifiers.has(code))
    )
  }

  private lostRelease(event: HookKey): boolean {
    for (const modifier of Object.keys(this.chord.modifiers) as Modifier[]) {
      if (!this.chord.modifiers[modifier]) continue
      // A mask transition is evidence of release; an always-false injected mask is not.
      if (event[modifier] === false && this.maskedModifiers.has(modifier)) return true
      if (event[modifier] === true) this.maskedModifiers.add(modifier)
    }
    return false
  }

  private release(): 'up' {
    this.held = false
    this.blockedUntilUp ||= this.primaryDown
    this.maskedModifiers.clear()
    return 'up'
  }

  down(event: HookKey): 'down' | 'cancel' | 'up' | null {
    if (Object.values(this.chord.modifierCodes).some((codes) => codes.has(event.keycode)))
      this.pressedModifiers.add(event.keycode)
    if (event.keycode === this.chord.keycode) this.primaryDown = true
    if (this.held) {
      if (event.keycode === this.escape) return 'cancel'
      return this.lostRelease(event) ? this.release() : null
    }
    if (this.blockedUntilUp || event.keycode !== this.chord.keycode) return null
    if (
      !Object.entries(this.chord.modifiers).every(([key, value]) => {
        const modifier = key as Modifier
        return this.pressed(event, modifier) === value
      })
    )
      return null
    this.held = true
    this.lostRelease(event)
    return 'down'
  }

  up(event: HookKey): 'up' | null {
    this.pressedModifiers.delete(event.keycode)
    if (event.keycode === this.chord.keycode) {
      this.primaryDown = false
      this.blockedUntilUp = false
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
