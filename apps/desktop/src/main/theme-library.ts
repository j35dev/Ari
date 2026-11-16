import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { z } from 'zod'
import {
  customThemeLibrarySchema,
  customThemeSchema,
  neonThemeExample,
  themeAuthoringGuide,
  themeDesignProblems,
  themeParts,
  type CustomTheme,
  type ThemeLibraryEvent,
} from '@ari/contracts/themes'
import { resolveCustomTheme, themePartSelectors } from '@ari/ui/custom-themes'
import type { SettingsStore } from '@ari/engine/settings'
import type { ThemeAssetStore } from './theme-assets'

export interface ThemeFiles {
  /** Folder holding the files the theme lists in `assets`. */
  assetsDir?: string | undefined
  /** Exported file contents keyed by hash (theme import). */
  assetData?: Record<string, string> | undefined
}

/** Hooks beyond the component parts that themes commonly style. */
const extraHooks = {
  'wallpaper plate': '.ari-wallpaper-pane',
  'empty-session art (sharp wallpaper)': '.ari-session-scene',
  'reading lane behind a running chat': '.ari-reading-lane',
  'bundled scene art': '.ari-scene',
}

/** All library writers share this queue; settings writes remain atomic. */
export class ThemeLibrary {
  #jobs: Promise<unknown> = Promise.resolve()
  constructor(
    private settings: SettingsStore,
    private publish: (event: ThemeLibraryEvent) => void,
    private assets?: ThemeAssetStore,
    /** PNG of the Ari window as the user currently sees it. */
    private capture?: () => Promise<{ png: Buffer; width: number; height: number }>,
  ) {}
  list(): ThemeLibraryEvent {
    return { themes: this.settings.current.appearance.customThemes ?? [] }
  }
  schema() {
    return {
      schema: z.toJSONSchema(customThemeSchema),
      guide: themeAuthoringGuide,
      hooks: { ...themePartSelectors, ...extraHooks },
      parts: themeParts,
      example: neonThemeExample,
    }
  }
  #previous(id: string): CustomTheme | undefined {
    return this.list().themes.find((entry) => entry.id === id)
  }
  #check(theme: unknown) {
    const parsed = customThemeSchema.parse(theme)
    resolveCustomTheme(parsed)
    const problems = themeDesignProblems(parsed)
    if (problems.length) throw new Error(problems.join('\n'))
    return parsed
  }
  async validate(theme: unknown, files: ThemeFiles = {}) {
    const parsed = this.#check(theme)
    if (this.assets)
      await this.assets.collect(parsed, {
        ...files,
        previous: this.#previous(parsed.id),
        write: false,
      })
    return { valid: true as const, theme: parsed }
  }
  #queue<T>(job: () => Promise<T>): Promise<T> {
    const next = this.#jobs.then(job)
    this.#jobs = next.catch(() => undefined)
    return next
  }
  #collectGarbage() {
    const appearance = this.settings.current.appearance
    return this.assets
      ?.collectGarbage([...(appearance.customThemes ?? []), appearance.activeCustomTheme])
      .catch(() => undefined)
  }
  async install(
    theme: unknown,
    preview = false,
    files: ThemeFiles = {},
  ): Promise<ThemeLibraryEvent> {
    const parsed = this.#check(theme)
    if (parsed.assets?.length && !this.assets)
      throw new Error('Theme files are unavailable in this runtime.')
    return this.#queue(async () => {
      const stored = this.assets
        ? await this.assets.collect(parsed, {
            ...files,
            previous: this.#previous(parsed.id),
            write: true,
          })
        : parsed
      const current = this.list().themes
      const themes = customThemeLibrarySchema.parse([
        ...current.filter((entry) => entry.id !== stored.id),
        stored,
      ])
      await this.settings.update({ appearance: { customThemes: themes } })
      await this.#collectGarbage()
      const event = { themes, ...(preview ? { previewId: stored.id } : {}) }
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
      await this.#collectGarbage()
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
  /** A portable copy: the theme plus its files. */
  async exportTheme(id: string) {
    const theme = this.#previous(id)
    if (!theme) throw new Error('Theme is not in your library.')
    return { theme, assetData: (await this.assets?.exportData(theme)) ?? {} }
  }
  /** Saves a PNG of the Ari window so an agent can look at its theme. */
  async screenshot(out?: string) {
    if (!this.capture) throw new Error('Screenshots are unavailable in this runtime.')
    if (out !== undefined && (!isAbsolute(out) || !out.toLowerCase().endsWith('.png')))
      throw new Error('--out must be an absolute path to a .png file.')
    const path = out ?? join(tmpdir(), 'ari-theme-screenshots', `ari-${Date.now()}.png`)
    const { png, width, height } = await this.capture()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, png)
    return { path, width, height }
  }
}
