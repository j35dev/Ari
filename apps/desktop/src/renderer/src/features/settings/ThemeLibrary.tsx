import { useRef, useState } from 'react'
import { Download, Palette, Plus, Trash2, Upload } from 'lucide-react'
import { useTheme } from '@ari/ui/theme-provider'
import { resolveCustomTheme } from '@ari/ui/custom-themes'
import { customThemeSchema, type CustomTheme } from '@ari/contracts/themes'
import { rpc } from '../../lib/rpc'
import { iconButton, outlineButton } from '../../lib/recipes'
import { SettingsSection } from './SettingsSection'

function ThemePreview({ theme }: { theme: CustomTheme }) {
  const { colors } = resolveCustomTheme(theme)
  const radius = theme.radii?.md ?? 6
  return (
    <div
      aria-hidden
      className="flex h-32 overflow-hidden"
      style={{ background: colors.bg, color: colors.fg }}
    >
      <div
        className="w-14 shrink-0 border-r p-2.5"
        style={{ background: colors['surface-0'], borderColor: colors.border }}
      >
        <div className="mb-4 h-2 w-6 rounded-sm" style={{ background: colors.accent }} />
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="mb-2 h-1.5 rounded-sm"
            style={{
              background: i === 1 ? colors.accent : colors['surface-3'],
              width: `${24 - i * 3}px`,
            }}
          />
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col p-3">
        <div className="mb-2 h-1.5 w-16 rounded-sm" style={{ background: colors['fg-muted'] }} />
        <div
          className="mb-3 ml-auto h-5 w-20"
          style={{ background: colors['surface-2'], borderRadius: radius }}
        />
        <div className="mb-1 h-1.5 w-20 rounded-sm" style={{ background: colors.fg }} />
        <div className="h-1.5 w-12 rounded-sm" style={{ background: colors['fg-subtle'] }} />
        <div
          className="mt-auto flex h-6 items-center justify-end border px-1.5"
          style={{
            background: colors['surface-1'],
            borderColor: colors['border-strong'],
            borderRadius: radius,
          }}
        >
          <div className="size-3 rounded-sm" style={{ background: colors.accent }} />
        </div>
      </div>
    </div>
  )
}

function exportTheme(theme: CustomTheme) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = `${theme.id.slice(7)}.ari-theme.json`
  link.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function ThemeLibrary() {
  const { customThemes, activeCustomTheme, mode, previewTheme, adoptLibrary } = useTheme()
  const input = useRef<HTMLInputElement>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const importTheme = async (file: File) => {
    setBusy(true)
    setNotice(null)
    try {
      if (file.size > 256 * 1024) throw new Error('Theme files must be smaller than 256 KiB.')
      const theme = customThemeSchema.parse(JSON.parse((await file.text()).replace(/^\uFEFF/, '')))
      resolveCustomTheme(theme)
      adoptLibrary(await rpc.invoke('theme.install', { theme, preview: true }))
      setNotice(`${theme.name} was added to your library.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not import this theme.')
    } finally {
      setBusy(false)
    }
  }
  const remove = async (theme: CustomTheme) => {
    setBusy(true)
    try {
      adoptLibrary(await rpc.invoke('theme.remove', { id: theme.id }))
      setNotice(`${theme.name} was removed.`)
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not remove the theme.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <SettingsSection
      title="Your themes"
      bare
      description="Designed by your agent. Saved here, ready to preview and make your own."
      action={
        <button
          type="button"
          className={outlineButton}
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          <Upload size={13} aria-hidden />
          Import theme
        </button>
      }
    >
      <input
        ref={input}
        type="file"
        accept=".json,.ari-theme.json,application/json"
        className="hidden"
        aria-label="Import Ari theme"
        onChange={(event) => {
          const file = event.currentTarget.files?.[0]
          event.currentTarget.value = ''
          if (file) void importTheme(file)
        }}
      />
      <div className="mb-4 flex items-center gap-3 rounded-lg border border-border px-3.5 py-3">
        <Palette size={18} strokeWidth={1.6} className="shrink-0 text-fg-subtle" aria-hidden />
        <div className="min-w-0 flex-1 text-[13px] text-fg-muted">
          In a chat, try <code className="text-fg">/ari theme neon cyan with sharp corners</code>.
          <p className="mt-0.5 text-xs text-fg-subtle">
            Your agent builds the theme; a 30-second preview lets you keep it or revert.
          </p>
        </div>
        <button
          type="button"
          className={outlineButton}
          onClick={() => {
            void navigator.clipboard.writeText('/ari theme neon cyan with sharp corners').then(
              () => setNotice('Theme request copied. Paste it into a chat with your agent.'),
              () => setNotice('Type /ari theme followed by your design idea in a chat.'),
            )
          }}
        >
          <Plus size={13} aria-hidden />
          Copy request
        </button>
      </div>
      {customThemes.length ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {customThemes.map((theme) => (
            <article
              key={theme.id}
              className="overflow-hidden rounded-xl border border-border bg-surface-1"
            >
              <button
                type="button"
                className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-ring"
                aria-label={`Preview ${theme.name}`}
                disabled={busy}
                onClick={() => previewTheme(theme.id)}
              >
                <ThemePreview theme={theme} />
                <div className="px-3.5 pb-1 pt-3">
                  <div className="flex items-center justify-between gap-2 text-sm font-medium">
                    <span className="truncate">{theme.name}</span>
                    {mode === theme.id && (
                      <span className="text-xs font-normal text-accent">
                        {activeCustomTheme &&
                        JSON.stringify(activeCustomTheme) !== JSON.stringify(theme)
                          ? 'New revision'
                          : 'Active'}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 line-clamp-2 min-h-8 text-xs leading-4 text-fg-subtle">
                    {theme.description || 'A custom Ari theme.'}
                  </p>
                </div>
              </button>
              <div className="flex items-center justify-between px-3.5 pb-3 pt-2">
                <button
                  type="button"
                  className={outlineButton}
                  disabled={busy}
                  onClick={() => previewTheme(theme.id)}
                >
                  Preview
                </button>
                <div className="flex gap-1">
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={`Export ${theme.name}`}
                    onClick={() => exportTheme(theme)}
                  >
                    <Download size={14} />
                  </button>
                  <button
                    type="button"
                    className={iconButton}
                    disabled={busy}
                    aria-label={`Remove ${theme.name}`}
                    onClick={() => void remove(theme)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="py-3 text-[13px] text-fg-subtle">
          Your first custom theme will appear here. Describe the look you want in a chat, or import
          a theme file.
        </p>
      )}
      {notice && (
        <p role="status" className="mt-3 break-words text-[13px] text-fg-muted">
          {notice}
        </p>
      )}
    </SettingsSection>
  )
}
