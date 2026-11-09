type ShortcutKey = Pick<
  KeyboardEvent,
  'code' | 'ctrlKey' | 'altKey' | 'metaKey' | 'shiftKey' | 'timeStamp' | 'getModifierState'
>

function modifierChord(code: string): string | null {
  const [, modifier, side] = /^(Alt|Control|Meta|Shift)(Left|Right)$/.exec(code) ?? []
  if (!modifier || !side) return null
  return `${modifier === 'Control' ? 'ctrl' : modifier.toLowerCase()}-${side.toLowerCase()}`
}

export class ModifierShortcutCapture {
  #held = new Set<string>()
  #candidate: { code: string; chord: string } | null = null
  #leftControlAt: number | null = null
  #syntheticControl = false

  press(event: ShortcutKey, windows: boolean): boolean {
    const chord = modifierChord(event.code)
    if (!chord) {
      this.#candidate = null
      return false
    }
    this.#held.add(event.code)
    if (event.code === 'ControlLeft') {
      this.#leftControlAt = event.timeStamp
      this.#syntheticControl = false
    }
    // Windows emits AltGr's virtual left Ctrl immediately before Right Alt.
    // A Ctrl held earlier remains a physical modifier and disqualifies capture.
    if (
      windows &&
      event.code === 'AltRight' &&
      event.getModifierState('AltGraph') &&
      this.#leftControlAt !== null &&
      event.timeStamp - this.#leftControlAt >= 0 &&
      event.timeStamp - this.#leftControlAt <= 1 &&
      this.#held.has('ControlLeft')
    ) {
      this.#held.delete('ControlLeft')
      this.#syntheticControl = true
    }
    const flags = [
      event.ctrlKey && !this.#syntheticControl,
      event.altKey,
      event.metaKey,
      event.shiftKey,
    ]
    const index = chord.startsWith('ctrl')
      ? 0
      : chord.startsWith('alt')
        ? 1
        : chord.startsWith('meta')
          ? 2
          : 3
    this.#candidate =
      this.#held.size === 1 && flags[index] && flags.filter(Boolean).length === 1
        ? { code: event.code, chord }
        : null
    return true
  }

  release(event: ShortcutKey): string | null {
    const remaining =
      event.altKey || event.metaKey || event.shiftKey || (event.ctrlKey && !this.#syntheticControl)
    const result =
      this.#candidate?.code === event.code && this.#held.size === 1 && !remaining
        ? this.#candidate.chord
        : null
    this.#held.delete(event.code)
    if (this.#candidate?.code === event.code) this.#candidate = null
    if (event.code === 'AltRight') this.#syntheticControl = false
    return result
  }

  reset(): void {
    this.#held.clear()
    this.#candidate = null
    this.#leftControlAt = null
    this.#syntheticControl = false
  }
}
