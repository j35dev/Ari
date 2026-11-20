import { useSyncExternalStore } from 'react'
import { z } from 'zod'

export const terminalPreferencesSchema = z
  .object({
    font: z.enum(['theme', 'cascadia', 'jetbrains', 'geist']).default('theme'),
    fontSize: z.number().int().min(11).max(24).default(14),
    lineHeight: z.number().min(1).max(1.8).default(1.2),
    cursor: z.enum(['bar', 'block', 'underline']).default('bar'),
    scrollback: z.number().int().min(1000).max(50_000).default(10_000),
    paneStyle: z.enum(['cards', 'seamless']).default('cards'),
    headerPosition: z.enum(['top', 'bottom']).default('top'),
    showDirectory: z.boolean().default(true),
    prefixKeys: z.boolean().default(false),
  })
  .strict()

export type TerminalPreferences = z.infer<typeof terminalPreferencesSchema>
export const DEFAULT_TERMINAL_PREFERENCES = terminalPreferencesSchema.parse({})
export const TERMINAL_PREFERENCES_KEY = 'ari.terminal.preferences.v1'
const listeners = new Set<() => void>()

function load(): TerminalPreferences {
  try {
    const raw = localStorage.getItem(TERMINAL_PREFERENCES_KEY)
    return raw ? terminalPreferencesSchema.parse(JSON.parse(raw)) : DEFAULT_TERMINAL_PREFERENCES
  } catch {
    return DEFAULT_TERMINAL_PREFERENCES
  }
}

let preferences = load()
export const terminalPreferences = (): TerminalPreferences => preferences
export function subscribeTerminalPreferences(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function useTerminalPreferences(): TerminalPreferences {
  return useSyncExternalStore(subscribeTerminalPreferences, terminalPreferences)
}
export function setTerminalPreferences(update: Partial<TerminalPreferences>): void {
  const next = terminalPreferencesSchema.parse({ ...preferences, ...update })
  if (JSON.stringify(next) === JSON.stringify(preferences)) return
  preferences = next
  try {
    localStorage.setItem(TERMINAL_PREFERENCES_KEY, JSON.stringify(next))
  } catch {
    /* in-memory preferences still apply */
  }
  for (const listener of listeners) listener()
}
