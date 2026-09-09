import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Cliamp V2 IPC: newline-delimited JSON over a Unix socket (including
 * Windows AF_UNIX). One request per connection, matching Cliamp's own client.
 * Spawning the 37MB binary for every play/pause/status is what made Focus lag.
 */

export function cliampSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): string {
  const override = env['CLIAMP_CONFIG_DIR']?.trim()
  if (override) return join(override, 'cliamp.sock')
  const xdg = env['XDG_CONFIG_HOME']?.trim()
  if (xdg) return join(xdg, 'cliamp', 'cliamp.sock')
  const home = env['HOME']?.trim()
  if (home) return join(home, '.config', 'cliamp', 'cliamp.sock')
  if (platform === 'win32') {
    const appData = env['APPDATA']?.trim()
    if (appData) return join(appData, 'cliamp', 'cliamp.sock')
  }
  return join(homedir(), '.config', 'cliamp', 'cliamp.sock')
}

export interface CliampIpcRequest {
  method: string
  operation?: string
  params?: unknown
  topics?: string[]
}

/** Sends one V2 envelope and returns the parsed response object. */
export function sendCliampIpc(
  sockPath: string,
  request: CliampIpcRequest,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      version: 2,
      id: 'ari',
      method: request.method,
      operation: request.operation,
      params: request.params ?? {},
      topics: request.topics,
    })
    const socket = createConnection({ path: sockPath })
    let buffer = ''
    let settled = false
    const finish = (error: Error | null, value?: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('ipc timeout')), timeoutMs)
    socket.on('error', (error) => finish(error))
    socket.on('connect', () => {
      socket.write(`${payload}\n`)
    })
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const nl = buffer.indexOf('\n')
      if (nl === -1) return
      const line = buffer.slice(0, nl).trim()
      try {
        finish(null, JSON.parse(line) as unknown)
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.on('end', () => {
      if (!settled) finish(new Error('ipc closed'))
    })
  })
}

export interface FocusMusicIpc {
  request(request: CliampIpcRequest, timeoutMs: number): Promise<unknown>
}

export function createCliampIpc(sockPath: () => string = cliampSocketPath): FocusMusicIpc {
  return {
    request: (request, timeoutMs) => sendCliampIpc(sockPath(), request, timeoutMs),
  }
}
