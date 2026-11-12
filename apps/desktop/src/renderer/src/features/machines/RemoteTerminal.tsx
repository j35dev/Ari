import { useEffect, useRef, useState } from 'react'
import { z } from 'zod'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { Button } from '@ari/ui/button'
import type { MachineView } from '@ari/contracts/machines'
import { remoteTerminalSchema } from '@ari/contracts/remote'
import { machineCan } from './use-machines'
import { messageOf, readReceipt, remoteQuery, resolveReceipt, sendRemote } from './remote-client'

const created = z.object({ terminalId: z.string().min(1) })
function tokenColor(name: string): string {
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return name === '--ari-bg' ? '#111111' : '#eeeeee'
  context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  context.fillRect(0, 0, 1, 1)
  const pixel = context.getImageData(0, 0, 1, 1).data
  return `rgb(${pixel[0]},${pixel[1]},${pixel[2]})`
}

/** A separate host PTY. No terminal-dock or local terminal RPC is imported. */
export function RemoteTerminal({
  machine,
  sessionId,
}: {
  machine: MachineView
  sessionId: string
}) {
  const element = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const terminalId = useRef<string | null>(null)
  const cursor = useRef(0)
  const alive = useRef(true)
  const input = useRef(Promise.resolve())
  const blocked = useRef(false)
  const machineRef = useRef(machine)
  machineRef.current = machine
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scope = `terminal:${sessionId}`
  const [pending, setPending] = useState(() => readReceipt(machine.id, scope))
  const can = (op: string) => machineRef.current.allowTerminal && machineCan(machineRef.current, op)
  useEffect(() => {
    alive.current = true
    if (!element.current) return
    const xterm = new Terminal({
      fontSize: 13,
      scrollback: 1500,
      cursorBlink: false,
      fontFamily: getComputedStyle(document.documentElement)
        .getPropertyValue('--ari-font-mono')
        .trim(),
      theme: {
        background: tokenColor('--ari-bg'),
        foreground: tokenColor('--ari-fg'),
        cursor: tokenColor('--ari-accent'),
      },
    })
    const fit = new FitAddon()
    xterm.loadAddon(fit)
    xterm.open(element.current)
    terminal.current = xterm
    const fail = (error: unknown) => {
      blocked.current = true
      xterm.options.disableStdin = true
      if (alive.current) {
        setError(messageOf(error))
        setPending(readReceipt(machine.id, scope))
      }
    }
    const data = xterm.onData((data) => {
      if (blocked.current || !terminalId.current || !can('terminal.write')) return
      const id = terminalId.current
      input.current = input.current
        .then(async () => {
          if (blocked.current || !alive.current || !can('terminal.write')) return
          await sendRemote(machine.id, scope, {
            op: 'terminal.write',
            sessionId,
            terminalId: id,
            data,
          })
        })
        .catch(fail)
    })
    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const resize = new ResizeObserver(() => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => {
        if (!alive.current) return
        fit.fit()
        const id = terminalId.current
        if (id && !blocked.current && can('terminal.resize'))
          input.current = input.current
            .then(async () => {
              if (blocked.current || !alive.current || !can('terminal.resize')) return
              await sendRemote(machine.id, scope, {
                op: 'terminal.resize',
                sessionId,
                terminalId: id,
                cols: Math.max(20, Math.min(300, xterm.cols)),
                rows: Math.max(5, Math.min(100, xterm.rows)),
              })
            })
            .catch(fail)
      }, 200)
    })
    resize.observe(element.current)
    return () => {
      alive.current = false
      blocked.current = true
      resize.disconnect()
      clearTimeout(resizeTimer)
      data.dispose()
      xterm.dispose()
      terminal.current = null
      const id = terminalId.current
      if (id && can('terminal.kill'))
        void sendRemote(machine.id, `terminal-close:${sessionId}`, {
          op: 'terminal.kill',
          sessionId,
          terminalId: id,
        }).catch(() => undefined)
    }
  }, [machine.id, sessionId, scope])
  useEffect(() => {
    if (!opened || !can('terminal.read')) return
    let disposed = false
    let inFlight = false
    const read = async () => {
      const id = terminalId.current
      if (!id || inFlight || disposed || !can('terminal.read')) return
      inFlight = true
      try {
        const page = remoteTerminalSchema.parse(
          await remoteQuery(machine.id, {
            op: 'terminal.read',
            sessionId,
            terminalId: id,
            fromSeq: cursor.current,
          }),
        )
        if (disposed || page.terminalId !== id) return
        if (page.error) throw new Error(page.error)
        if (page.reset) terminal.current?.reset()
        terminal.current?.write(page.data)
        cursor.current = page.seq
        if (page.exited) {
          blocked.current = true
          setError('Host terminal exited.')
          if (terminal.current) terminal.current.options.disableStdin = true
        }
      } catch (error) {
        if (!disposed) setError(messageOf(error))
      } finally {
        inFlight = false
      }
    }
    void read()
    const timer = setInterval(() => void read(), 700)
    return () => {
      disposed = true
      clearInterval(timer)
    }
  }, [machine.id, machine.status, machine.allowTerminal, sessionId, opened])
  async function open(): Promise<void> {
    if (!can('terminal.create') || busy) return
    setBusy(true)
    setError(null)
    try {
      const receipt = readReceipt(machine.id, scope)
      const result = receipt
        ? await resolveReceipt(machine.id, scope)
        : await sendRemote(machine.id, scope, {
            op: 'terminal.create',
            sessionId,
            cols: 80,
            rows: 24,
          })
      if (!alive.current) {
        if ((!receipt || receipt.command.op === 'terminal.create') && can('terminal.kill'))
          void sendRemote(machine.id, `terminal-close:${sessionId}`, {
            op: 'terminal.kill',
            sessionId,
            terminalId: created.parse(result).terminalId,
          }).catch(() => undefined)
        return
      }
      if (!receipt || receipt.command.op === 'terminal.create') {
        terminalId.current = created.parse(result).terminalId
        setOpened(true)
      }
      if (receipt?.command.op === 'terminal.kill') {
        terminalId.current = null
        cursor.current = 0
        setOpened(false)
        terminal.current?.reset()
      }
      blocked.current = false
      if (terminal.current) {
        terminal.current.options.disableStdin = false
        terminal.current.focus()
      }
    } catch (error) {
      if (alive.current) setError(messageOf(error))
    } finally {
      if (alive.current) {
        setBusy(false)
        setPending(readReceipt(machine.id, scope))
      }
    }
  }
  return (
    <section
      aria-label={`Terminal on ${machine.name}`}
      className="flex min-h-0 flex-1 flex-col p-4"
    >
      <div className="mb-3 flex items-center gap-2">
        <p className="mr-auto text-xs text-fg-muted">
          Granted shell on {machine.name} · Runs as the host user
        </p>
        {!opened && !pending && (
          <Button size="sm" disabled={busy || !can('terminal.create')} onClick={() => void open()}>
            Open host terminal
          </Button>
        )}
        {opened && (
          <Button
            size="sm"
            disabled={busy || !can('terminal.kill')}
            onClick={() => {
              const id = terminalId.current
              if (!id) return
              setBusy(true)
              void sendRemote(machine.id, scope, { op: 'terminal.kill', sessionId, terminalId: id })
                .then(() => {
                  terminalId.current = null
                  setOpened(false)
                  cursor.current = 0
                  terminal.current?.reset()
                })
                .catch((error: unknown) => setError(messageOf(error)))
                .finally(() => {
                  setBusy(false)
                  setPending(readReceipt(machine.id, scope))
                })
            }}
          >
            Close terminal
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="mb-3 text-xs text-danger">
          {error}
        </p>
      )}
      {pending && (
        <div className="mb-3 flex items-center gap-2">
          <p className="text-xs text-warning">Terminal action unconfirmed. Input is blocked.</p>
          <Button size="sm" disabled={busy || !can('command.status')} onClick={() => void open()}>
            Check terminal receipt
          </Button>
        </div>
      )}
      <div
        ref={element}
        className="min-h-0 flex-1 overflow-hidden rounded-md border border-border bg-bg p-2"
      />
    </section>
  )
}
