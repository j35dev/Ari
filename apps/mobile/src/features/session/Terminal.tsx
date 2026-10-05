import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { Terminal as Xterm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { LoaderCircle, Square, TerminalSquare } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import { useApp } from '../../lib/app-state'
import { TerminalWriter } from '../../lib/terminal-writer'
import { closeRemoteTerminal } from '../../lib/terminal-close'
import { readTerminalState, writeTerminalState } from '../../lib/terminal-state'

interface TerminalPage {
  terminalId: string
  data: string
  seq: number
  reset: boolean
  exited: boolean
  hasMore: boolean
  error: string | null
}

function tokenColor(token: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('Canvas is unavailable in this browser.')
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(token).trim()
  context.fillRect(0, 0, 1, 1)
  const pixel = context.getImageData(0, 0, 1, 1).data
  return `rgb(${pixel[0]},${pixel[1]},${pixel[2]})`
}

/** A device-owned PTY, available only after an explicit desktop shell permission grant. */
export function Terminal({ sessionId, active }: { sessionId: string; active: boolean }): ReactNode {
  const app = useApp()
  const deviceId = app.session?.deviceId ?? null
  const [restored] = useState(() => readTerminalState(app.origin, deviceId, sessionId))
  const host = useRef<HTMLDivElement>(null)
  const terminal = useRef<Xterm | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const id = useRef<string | null>(restored.terminalId)
  const cursor = useRef(0)
  const creating = useRef<string | null>(restored.creationKey)
  const writer = useRef<TerminalWriter | null>(null)
  const [started, setStarted] = useState(restored.terminalId !== null)
  const [busy, setBusy] = useState(false)
  const [exited, setExited] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [command, setCommand] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [desired, setDesired] = useState(!restored.closed)
  const [inputBlocked, setInputBlocked] = useState(false)
  const current = useEffectEvent(() => ({ session: app.session, active }))
  const sendInput = useEffectEvent(async (data: string, key: string): Promise<void> => {
    const session = app.session
    if (session === null || id.current === null || !session.usable || !session.allowTerminal)
      throw new Error('Reconnect before sending terminal input.')
    await session.send({ op: 'terminal.write', sessionId, terminalId: id.current, data }, key)
  })
  const write = useEffectEvent(async (data: string): Promise<void> => {
    if (writer.current === null) throw new Error('The terminal input connection is not ready.')
    await writer.current.write(data)
  })
  useEffect(() => {
    const element = host.current
    if (element === null) return
    const xterm = new Xterm({
      fontFamily: getComputedStyle(document.documentElement)
        .getPropertyValue('--ari-font-mono')
        .trim(),
      fontSize: 13,
      lineHeight: 1.3,
      scrollback: 1500,
      cursorBlink: false,
      convertEol: false,
      theme: {
        background: tokenColor('--ari-bg'),
        foreground: tokenColor('--ari-fg'),
        cursor: tokenColor('--ari-accent'),
        selectionBackground: tokenColor('--ari-surface-3'),
      },
    })
    const addon = new FitAddon()
    xterm.loadAddon(addon)
    xterm.open(element)
    terminal.current = xterm
    fit.current = addon
    writer.current = new TerminalWriter(sendInput, (error) => {
      setInputBlocked(true)
      xterm.options.disableStdin = true
      setFailure(error instanceof Error ? error.message : 'Terminal input was not acknowledged.')
    })
    const input = xterm.onData((data) => {
      void write(data).catch((error: unknown) =>
        setFailure(error instanceof Error ? error.message : 'Could not write to the terminal.'),
      )
    })
    const theme = new MutationObserver(() => {
      xterm.options.theme = {
        background: tokenColor('--ari-bg'),
        foreground: tokenColor('--ari-fg'),
        cursor: tokenColor('--ari-accent'),
        selectionBackground: tokenColor('--ari-surface-3'),
      }
    })
    theme.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-ari-theme'],
    })
    return () => {
      theme.disconnect()
      input.dispose()
      writer.current?.dispose()
      writer.current = null
      xterm.dispose()
      terminal.current = null
      fit.current = null
    }
  }, [])
  useEffect(() => {
    const session = app.session
    if (session === null || !session.usable || !session.allowTerminal || !active || !desired) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const read = async (): Promise<void> => {
      if (cancelled) return
      try {
        if (id.current === null) {
          creating.current ??= crypto.randomUUID()
          writeTerminalState(app.origin, deviceId, sessionId, {
            terminalId: null,
            creationKey: creating.current,
            closed: false,
          })
          const result = (await session.send(
            {
              op: 'terminal.create',
              sessionId,
              cols: Math.min(300, Math.max(20, terminal.current?.cols ?? 80)),
              rows: Math.min(100, Math.max(5, terminal.current?.rows ?? 24)),
            },
            creating.current,
          )) as { result?: { terminalId?: string }; terminalId?: string }
          const nextId = result.result?.terminalId ?? result.terminalId
          if (nextId === undefined)
            throw new Error(
              'The computer did not return a terminal. Retry checks the same creation.',
            )
          id.current = nextId
          creating.current = null
          writeTerminalState(app.origin, deviceId, sessionId, {
            terminalId: nextId,
            creationKey: null,
            closed: false,
          })
          if (!cancelled) setStarted(true)
        }
        if (document.visibilityState === 'visible' && current().active) {
          for (let page = 0; page < 8; page++) {
            const result = await session.query<TerminalPage | null>('terminal.read', {
              sessionId,
              terminalId: id.current,
              fromSeq: cursor.current,
            })
            if (cancelled) return
            if (result === null || result.error !== null)
              throw new Error(
                result?.error ??
                  'This terminal is no longer available. Close it and start another.',
              )
            if (result.reset) terminal.current?.reset()
            terminal.current?.write(result.data)
            cursor.current = result.seq
            setExited(result.exited)
            if (!inputBlocked) setFailure(null)
            if (!result.hasMore || result.exited) break
          }
        }
      } catch (error) {
        if (!cancelled)
          setFailure(error instanceof Error ? error.message : 'Could not read the terminal.')
      } finally {
        if (!cancelled)
          timer = setTimeout(() => {
            void read()
          }, 1000)
      }
    }
    void read()
    return () => {
      cancelled = true
      if (timer !== null) clearTimeout(timer)
    }
  }, [
    app.session,
    app.connection,
    app.origin,
    deviceId,
    sessionId,
    active,
    revision,
    desired,
    inputBlocked,
  ])
  useEffect(() => {
    const element = host.current
    if (element === null || !active) return
    const resize = (): void => {
      fit.current?.fit()
      const xterm = terminal.current
      if (xterm === null || id.current === null) return
      const session = current().session
      if (session !== null && session.usable)
        void session
          .send({
            op: 'terminal.resize',
            sessionId,
            terminalId: id.current,
            cols: Math.min(300, Math.max(20, xterm.cols)),
            rows: Math.min(100, Math.max(5, xterm.rows)),
          })
          .catch((error: unknown) =>
            setFailure(error instanceof Error ? error.message : 'Could not resize the terminal.'),
          )
    }
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    return () => observer.disconnect()
  }, [sessionId, active, started])
  async function close(): Promise<void> {
    const session = app.session
    const terminalId = id.current
    if (session === null || terminalId === null || busy) return
    setBusy(true)
    try {
      await closeRemoteTerminal(() => session.send({ op: 'terminal.kill', sessionId, terminalId }))
      writer.current?.dispose()
      writer.current = new TerminalWriter(sendInput, (error) => {
        setInputBlocked(true)
        if (terminal.current !== null) terminal.current.options.disableStdin = true
        setFailure(error instanceof Error ? error.message : 'Terminal input was not acknowledged.')
      })
      id.current = null
      cursor.current = 0
      setExited(false)
      setStarted(false)
      setConfirming(false)
      setDesired(false)
      setInputBlocked(false)
      terminal.current?.reset()
      writeTerminalState(app.origin, deviceId, sessionId, {
        terminalId: null,
        creationKey: null,
        closed: true,
      })
      if (terminal.current !== null) terminal.current.options.disableStdin = false
    } catch (error) {
      setFailure(error instanceof Error ? error.message : 'Could not close this terminal.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className={`flex h-full min-h-0 flex-col ${active ? '' : 'hidden'}`}>
      <div className="mb-2 flex shrink-0 items-center justify-between gap-2 text-xs text-fg-muted">
        <span className="flex items-center gap-2">
          <TerminalSquare size={15} />
          {!desired
            ? 'Shell closed'
            : exited
              ? 'Shell exited'
              : started
                ? 'Workspace terminal'
                : 'Opening shell…'}
        </span>
        <button
          type="button"
          className="min-h-11 text-danger"
          disabled={!started || busy}
          onClick={() => setConfirming(true)}
        >
          Close shell
        </button>
      </div>
      <div ref={host} className="min-h-0 flex-1 overflow-hidden" />
      {!started && desired && (
        <p role="status" className="flex items-center gap-2 py-2 text-xs text-fg-muted">
          <LoaderCircle size={13} className="animate-spin" />
          Starting on your computer
        </p>
      )}
      {!desired && (
        <button
          type="button"
          className="primary-button my-3 shrink-0"
          onClick={() => setDesired(true)}
        >
          Open a new shell
        </button>
      )}
      {failure !== null && (
        <div role="alert" className="error-banner shrink-0">
          <p>{failure}</p>
          <button
            type="button"
            className="min-h-11 font-medium"
            onClick={() => {
              if (inputBlocked) {
                void writer.current
                  ?.retry()
                  .then(() => {
                    setInputBlocked(false)
                    setFailure(null)
                    if (terminal.current !== null) terminal.current.options.disableStdin = false
                  })
                  .catch((error: unknown) =>
                    setFailure(
                      error instanceof Error ? error.message : 'Terminal input retry failed.',
                    ),
                  )
              } else setRevision((value) => value + 1)
            }}
          >
            {inputBlocked ? 'Retry same terminal input' : 'Retry'}
          </button>
        </div>
      )}
      <div className="mt-2 flex shrink-0 gap-1 border-t border-border pt-1">
        {[
          { label: 'Tab', value: '\t' },
          { label: 'Esc', value: '\u001b' },
          { label: '↑', value: '\u001b[A' },
          { label: '↓', value: '\u001b[B' },
          { label: 'Ctrl C', value: '\u0003' },
        ].map((key) => (
          <button
            type="button"
            className="min-h-11 flex-1 rounded-lg border border-border text-xs text-fg-muted"
            key={key.label}
            disabled={!started || exited || busy || inputBlocked || app.connection !== 'connected'}
            onClick={() => {
              void write(key.value).catch((error: unknown) =>
                setFailure(error instanceof Error ? error.message : 'Could not send this key.'),
              )
            }}
          >
            {key.label === 'Ctrl C' ? (
              <span className="flex items-center justify-center gap-1">
                <Square size={9} />
                Ctrl C
              </span>
            ) : (
              key.label
            )}
          </button>
        ))}
      </div>
      <form
        className="mt-2 flex shrink-0 gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          if (!command || busy) return
          setBusy(true)
          void write(`${command}\r`)
            .then(() => setCommand(''))
            .catch((error: unknown) =>
              setFailure(error instanceof Error ? error.message : 'Could not run this command.'),
            )
            .finally(() => setBusy(false))
        }}
      >
        <input
          value={command}
          onChange={(event) => setCommand(event.target.value)}
          aria-label="Terminal command"
          placeholder="Type a shell command"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={!started || exited || busy || inputBlocked || app.connection !== 'connected'}
          className="min-h-12 min-w-0 flex-1 rounded-xl border border-border bg-surface-1 px-3 font-mono"
        />
        <button
          type="submit"
          className="secondary-button"
          disabled={!started || !command || busy || exited || inputBlocked || app.connection !== 'connected'}
        >
          Run
        </button>
      </form>
      {confirming && (
        <div className="mt-2 shrink-0 rounded-xl border border-border bg-surface-1 p-3 text-xs">
          <p>Close this shell and its running processes?</p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="secondary-button flex-1"
              onClick={() => setConfirming(false)}
            >
              Keep open
            </button>
            <button
              type="button"
              className="primary-button flex-1 bg-danger"
              disabled={busy}
              onClick={() => void close()}
            >
              Close shell
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
