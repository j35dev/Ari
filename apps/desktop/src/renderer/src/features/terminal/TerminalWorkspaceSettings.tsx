import { useState } from 'react'
import { Check, Copy, RotateCcw, X } from 'lucide-react'
import { Dialog } from '@ari/ui/dialog'
import {
  DEFAULT_TERMINAL_PREFERENCES,
  setTerminalPreferences,
  terminalPreferencesSchema,
  useTerminalPreferences,
  type TerminalPreferences,
} from './terminal-preferences'

export const TERMINAL_SHORTCUTS = [
  ['New terminal', 'Ctrl/Cmd+Shift+T'],
  ['New space', 'Ctrl/Cmd+Shift+N'],
  ['Split right / below', 'Ctrl/Cmd+Shift+O / E'],
  ['Focus a pane', 'Ctrl/Cmd+Shift+Arrow'],
  ['Zoom a pane', 'Ctrl/Cmd+Shift+Z'],
  ['Find in terminal', 'Ctrl/Cmd+Shift+F'],
  ['Next / previous task', 'Ctrl+Tab / Ctrl+Shift+Tab'],
  ['Park task', 'Ctrl/Cmd+Shift+W'],
  ['Command palette', 'Ctrl/Cmd+Shift+P'],
] as const

export function TerminalWorkspaceSettings({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const prefs = useTerminalPreferences()
  const [editing, setEditing] = useState(false)
  const [json, setJson] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const update = (value: Partial<TerminalPreferences>): void => setTerminalPreferences(value)
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(prefs, null, 2))
      setCopied(true)
    } catch {
      setError('Could not copy the configuration. Open Edit configuration to select it.')
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose()
      }}
    >
      <Dialog.Content size="lg" className="ari-terminal-settings">
        <header>
          <div>
            <Dialog.Title>Terminal workspace</Dialog.Title>
            <Dialog.Description>Set up a desk that feels like yours.</Dialog.Description>
          </div>
          <button
            type="button"
            className="ari-terminal-pane-button"
            aria-label="Close terminal preferences"
            onClick={onClose}
          >
            <X size={16} aria-hidden />
          </button>
        </header>
        <div className="ari-terminal-settings-content">
          <section>
            <h3>Text and cursor</h3>
            <p>Terminal metrics are independent from conversation text.</p>
            <div className="ari-terminal-settings-fields">
              <label>
                Font
                <select
                  value={prefs.font}
                  onChange={(event) =>
                    update({ font: event.target.value as TerminalPreferences['font'] })
                  }
                >
                  <option value="theme">Use Ari theme font</option>
                  <option value="geist">Geist Mono</option>
                  <option value="jetbrains">JetBrains Mono</option>
                  <option value="cascadia">Cascadia Code</option>
                </select>
              </label>
              <label>
                Text size
                <select
                  value={prefs.fontSize}
                  onChange={(event) => update({ fontSize: Number(event.target.value) })}
                >
                  {Array.from({ length: 14 }, (_, index) => index + 11).map((size) => (
                    <option key={size} value={size}>
                      {size} px
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Line spacing
                <select
                  value={prefs.lineHeight}
                  onChange={(event) => update({ lineHeight: Number(event.target.value) })}
                >
                  {[1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.8].map((height) => (
                    <option key={height} value={height}>
                      {height === 1 ? 'Compact' : height === 1.2 ? 'Balanced' : `${height}×`}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Cursor
                <select
                  value={prefs.cursor}
                  onChange={(event) =>
                    update({ cursor: event.target.value as TerminalPreferences['cursor'] })
                  }
                >
                  <option value="bar">Bar</option>
                  <option value="block">Block</option>
                  <option value="underline">Underline</option>
                </select>
              </label>
            </div>
          </section>
          <section>
            <h3>Pane appearance</h3>
            <p>Colors follow your Ari theme, including its sixteen terminal colors.</p>
            <div className="ari-terminal-settings-fields">
              <label>
                Pane frames
                <select
                  value={prefs.paneStyle}
                  onChange={(event) =>
                    update({ paneStyle: event.target.value as TerminalPreferences['paneStyle'] })
                  }
                >
                  <option value="cards">Quiet cards</option>
                  <option value="seamless">Seamless grid</option>
                </select>
              </label>
              <label>
                Pane headers
                <select
                  value={prefs.headerPosition}
                  onChange={(event) =>
                    update({
                      headerPosition: event.target.value as TerminalPreferences['headerPosition'],
                    })
                  }
                >
                  <option value="top">At the top</option>
                  <option value="bottom">At the bottom</option>
                </select>
              </label>
              <label>
                History
                <select
                  value={prefs.scrollback}
                  onChange={(event) => update({ scrollback: Number(event.target.value) })}
                >
                  {[1000, 5000, 10000, 25000, 50000].map((lines) => (
                    <option value={lines} key={lines}>
                      {lines.toLocaleString()} lines
                    </option>
                  ))}
                </select>
              </label>
              <label className="ari-terminal-checkbox">
                <input
                  type="checkbox"
                  checked={prefs.showDirectory}
                  onChange={(event) => update({ showDirectory: event.target.checked })}
                />
                Show working directory
              </label>
            </div>
          </section>
          <section>
            <h3>Keyboard</h3>
            <label className="ari-terminal-checkbox">
              <input
                type="checkbox"
                checked={prefs.prefixKeys}
                onChange={(event) => update({ prefixKeys: event.target.checked })}
              />
              Use Ctrl+B prefix navigation
            </label>
            <p>
              Press Ctrl+B twice to send the prefix to the CLI. Your other shell control keys stay
              available.
            </p>
            <dl className="ari-terminal-shortcuts">
              {TERMINAL_SHORTCUTS.map(([label, chord]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{chord}</dd>
                </div>
              ))}
            </dl>
          </section>
          {editing && (
            <section>
              <h3>Edit configuration</h3>
              <p>Copy this into an agent to adjust it, then paste the validated settings here.</p>
              <textarea
                aria-label="Terminal configuration JSON"
                value={json}
                spellCheck={false}
                onChange={(event) => setJson(event.target.value)}
              />
              <button
                type="button"
                className="ari-terminal-text-button"
                onClick={() => {
                  try {
                    const value = terminalPreferencesSchema.parse(JSON.parse(json))
                    setTerminalPreferences(value)
                    setError(null)
                    setEditing(false)
                  } catch {
                    setError('Use valid JSON with the supported terminal settings and values.')
                  }
                }}
              >
                <Check size={13} aria-hidden />
                Apply configuration
              </button>
            </section>
          )}
          {error && (
            <p className="ari-terminal-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer>
          <button
            type="button"
            className="ari-terminal-text-button"
            onClick={() => setTerminalPreferences(DEFAULT_TERMINAL_PREFERENCES)}
          >
            <RotateCcw size={13} aria-hidden />
            Reset
          </button>
          <span />
          <button
            type="button"
            className="ari-terminal-text-button"
            onClick={() => {
              setJson(JSON.stringify(prefs, null, 2))
              setEditing(!editing)
              setError(null)
            }}
          >
            Edit configuration
          </button>
          <button type="button" className="ari-terminal-text-button" onClick={() => void copy()}>
            {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
            {copied ? 'Copied' : 'Copy configuration'}
          </button>
        </footer>
      </Dialog.Content>
    </Dialog>
  )
}
