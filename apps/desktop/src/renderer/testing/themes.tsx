import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import '@ari/ui/fonts'
import '../src/styles/index.css'
import '../src/features/composer/composer.css'
import { ThemeProvider, useTheme } from '@ari/ui/theme-provider'
import { themePersistence } from '../src/lib/theme-persistence'
import { customThemeSchema, neonThemeExample } from '@ari/contracts/themes'
import { settingsSchema } from '@ari/contracts/settings'
import type { StreamFrame } from '@ari/contracts/rpc'
import { ThemeLibrary } from '../src/features/settings/ThemeLibrary'
import { SettingsPage } from '../src/features/settings/SettingsPage'
import { primaryButton, outlineButton, row } from '../src/lib/recipes'

// Visual fixture using the real provider, settings adapter and library UI.
let settings = settingsSchema.parse({
  version: 1,
  appearance: { mode: 'obsidian', themeId: 'obsidian', customThemes: [neonThemeExample] },
})
const subscribers = new Map<string, (frame: StreamFrame) => void>()
const subscriptions = new Map<string, string>()
window.ari = {
  async invoke(method, raw) {
    await Promise.resolve()
    const params = raw as Record<string, unknown>
    if (method === 'settings.get') return settings
    if (method === 'settings.update') {
      settings = settingsSchema.parse({
        ...settings,
        appearance: { ...settings.appearance, ...(params['appearance'] as object) },
      })
      return settings
    }
    if (method === 'theme.apply') return { applied: true }
    if (method === 'stream.subscribe') {
      subscriptions.set(params['id'] as string, params['name'] as string)
      return {}
    }
    if (method === 'stream.unsubscribe') {
      subscriptions.delete(params['id'] as string)
      return {}
    }
    if (method === 'theme.remove' || method === 'theme.install') {
      const theme =
        method === 'theme.install' ? customThemeSchema.parse(params['theme']) : undefined
      const themes = (settings.appearance.customThemes ?? []).filter(
        (entry) => entry.id !== (theme?.id ?? params['id']),
      )
      if (theme) themes.push(theme)
      settings = settingsSchema.parse({
        ...settings,
        appearance: { ...settings.appearance, customThemes: themes },
      })
      const event = { themes, ...(theme && params['preview'] ? { previewId: theme.id } : {}) }
      for (const [id, listener] of subscribers)
        if (subscriptions.get(id) === 'themes.changed')
          listener({ id, name: 'themes.changed', payload: event })
      return event
    }
    throw new Error(`Unsupported fixture method: ${method}`)
  },
  subscribe(id, listener) {
    subscribers.set(id, listener)
    return () => subscribers.delete(id)
  },
}
localStorage.setItem('ari.theme', JSON.stringify({ mode: 'obsidian', wallpaper: 'none' }))

function Fixture() {
  const { theme, mode, customThemes } = useTheme()
  useEffect(() => {
    Object.assign(window, {
      __ari: {
        state: () => ({
          theme: theme.id,
          confirmedMode: mode,
          library: customThemes.map((entry) => entry.name),
          foreground: getComputedStyle(document.documentElement).getPropertyValue('--ari-fg'),
          background: getComputedStyle(document.documentElement).getPropertyValue('--ari-bg'),
          persistedMode: settings.appearance.mode,
        }),
      },
    })
  }, [theme, mode, customThemes])
  return (
    <div className="ari-frame flex h-dvh flex-col p-2">
      <header
        data-ari-part="titlebar"
        className="flex h-11 shrink-0 items-center px-3 text-sm text-fg-subtle"
      >
        Ari <span className="ml-auto text-xs">Theme library preview</span>
      </header>
      <div className="flex min-h-0 flex-1 gap-2">
        <nav data-ari-part="sidebar" className="w-44 shrink-0 p-3 text-[13px]">
          <div className="mb-5 text-lg font-semibold text-fg">Your workspace</div>
          {['New session', 'Ari themes', 'Projects', 'Changes'].map((name) => (
            <button key={name} className={row}>
              {name}
            </button>
          ))}
          <p className="mt-8 px-2.5 text-xs text-fg-subtle">
            Agent-designed themes stay in your personal library.
          </p>
        </nav>
        <main className="ari-stage ari-scroll min-w-0 flex-1 overflow-y-auto">
          <SettingsPage
            title="Make Ari yours"
            description="Preview the real theme library and component skins."
          >
            <ThemeLibrary />
            <section className="space-y-4 text-sm">
              <h2 className="font-medium text-fg-muted">Component preview</h2>
              <div className="ari-user-bubble ml-auto w-fit rounded-2xl bg-surface-2 px-4 py-3">
                Design me a neon theme for Ari.
              </div>
              <p data-ari-part="assistant-message">
                A cool midnight palette, luminous cyan accents, and crisp component edges.
              </p>
              <div
                data-ari-part="tool-call"
                className="rounded-lg border border-border p-3 text-fg-muted"
              >
                Theme validated · Saved to your library
              </div>
              <div className="ari-composer-shell rounded-2xl border border-border bg-surface-1 p-4">
                <textarea
                  className="ari-composer-field w-full resize-none bg-transparent text-fg outline-none"
                  aria-label="Theme idea"
                  placeholder="Describe your next theme…"
                />
                <div className="mt-3 flex justify-end gap-2">
                  <button className={outlineButton}>Attach</button>
                  <button className={primaryButton}>Send</button>
                </div>
              </div>
            </section>
          </SettingsPage>
        </main>
      </div>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(
  <ThemeProvider persistence={themePersistence}>
    <Fixture />
  </ThemeProvider>,
)
