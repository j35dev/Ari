import { z } from 'zod'
import {
  customThemeLibrarySchema,
  customThemeSchema,
  neonThemeExample,
  themeParts,
  type ThemeLibraryEvent,
} from '@ari/contracts/themes'
import { resolveCustomTheme } from '@ari/ui/custom-themes'
import type { SettingsStore } from '@ari/engine/settings'

/** All library writers share this queue; settings writes remain atomic. */
export class ThemeLibrary {
  #jobs: Promise<unknown> = Promise.resolve()
  constructor(
    private settings: SettingsStore,
    private publish: (event: ThemeLibraryEvent) => void,
  ) {}
  list(): ThemeLibraryEvent {
    return { themes: this.settings.current.appearance.customThemes ?? [] }
  }
  schema() {
    return {
      schema: z.toJSONSchema(customThemeSchema),
      parts: themeParts,
      example: neonThemeExample,
    }
  }
  validate(theme: unknown) {
    const parsed = customThemeSchema.parse(theme)
    resolveCustomTheme(parsed)
    return { valid: true as const, theme: parsed }
  }
  #queue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.#jobs.then(job)
    this.#jobs = next.catch(() => undefined)
    return next
  }
  install(theme: unknown, preview = false): Promise<ThemeLibraryEvent> {
    const parsed = this.validate(theme).theme
    return this.#queue(async () => {
      const current = this.list().themes
      const themes = customThemeLibrarySchema.parse([
        ...current.filter((entry) => entry.id !== parsed.id),
        parsed,
      ])
      await this.settings.update({ appearance: { customThemes: themes } })
      const event = { themes, ...(preview ? { previewId: parsed.id } : {}) }
      this.publish(event)
      return event
    })
  }
  remove(id: string): Promise<ThemeLibraryEvent> {
    return this.#queue(async () => {
      const appearance = this.settings.current.appearance
      const themes = this.list().themes.filter((entry) => entry.id !== id)
      const reset = appearance.mode === id || appearance.themeId === id
      await this.settings.update({
        appearance: {
          customThemes: themes,
          ...(reset ? { mode: 'obsidian', themeId: 'obsidian', activeCustomTheme: null } : {}),
        },
      })
      const event = { themes, ...(reset ? { reset: true } : {}) }
      this.publish(event)
      return event
    })
  }
  preview(id: string) {
    if (!this.list().themes.some((theme) => theme.id === id))
      throw new Error('Theme is not in your library.')
    const event = { ...this.list(), previewId: id }
    this.publish(event)
    return { requested: true, themeId: id }
  }
  reset() {
    return this.#queue(async () => {
      await this.settings.update({
        appearance: {
          mode: 'obsidian',
          themeId: 'obsidian',
          activeCustomTheme: null,
          wallpaper: 'none',
        },
      })
      const event = { ...this.list(), reset: true }
      this.publish(event)
      return event
    })
  }
}
