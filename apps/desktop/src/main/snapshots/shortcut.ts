/** Electron accelerators from the same physical-key grammar as dictation. */
const keys: Record<string, string> = {
  ctrl: 'Control',
  alt: 'Alt',
  shift: 'Shift',
  meta: 'Super',
  space: 'Space',
  enter: 'Enter',
  comma: ',',
  period: '.',
  slash: '/',
  semicolon: ';',
  quote: "'",
  backquote: '`',
  minus: '-',
  equal: '=',
  bracketleft: '[',
  bracketright: ']',
  backslash: '\\',
}
export function snapshotAccelerator(shortcut: string): string {
  return shortcut
    .split('+')
    .map((part) => keys[part] ?? part.toUpperCase())
    .join('+')
}

export interface ShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

/** Register the replacement first so a refused chord leaves the old one intact. */
export class SnapshotShortcut {
  private current: string | null = null
  constructor(
    private readonly registry: ShortcutRegistry,
    private readonly capture: () => void,
  ) {}
  get registered(): boolean {
    return this.current !== null
  }
  configure(shortcut: string | null): void {
    const next = shortcut === null ? null : snapshotAccelerator(shortcut)
    if (next === this.current) return
    if (next && !this.registry.register(next, this.capture))
      throw new Error(
        'This shortcut could not be registered. Another app or the operating system may already use it. Choose another shortcut.',
      )
    if (this.current) this.registry.unregister(this.current)
    this.current = next
  }
  dispose(): void {
    this.configure(null)
  }
}
