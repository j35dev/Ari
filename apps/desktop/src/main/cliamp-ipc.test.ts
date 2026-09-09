import { describe, expect, it } from 'vitest'
import { createServer } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliampSocketPath, sendCliampIpc } from './cliamp-ipc'

describe('cliampSocketPath', () => {
  it('follows Cliamp config-dir order', () => {
    expect(cliampSocketPath({ CLIAMP_CONFIG_DIR: 'D:\\cfg' }, 'win32')).toBe(join('D:\\cfg', 'cliamp.sock'))
    expect(cliampSocketPath({ XDG_CONFIG_HOME: '/xdg' }, 'linux')).toBe(
      join('/xdg', 'cliamp', 'cliamp.sock'),
    )
    expect(cliampSocketPath({ APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'win32')).toBe(
      join('C:\\Users\\a\\AppData\\Roaming', 'cliamp', 'cliamp.sock'),
    )
  })
})

describe('sendCliampIpc', () => {
  it.skipIf(process.platform === 'win32')(
    'writes one NDJSON request and returns the response line',
    async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-ipc-'))
    const sock = join(dir, 'cliamp.sock')
    const server = createServer((socket) => {
      let buf = ''
      socket.setEncoding('utf8')
      socket.on('data', (chunk: string) => {
        buf += chunk
        if (!buf.includes('\n')) return
        socket.end(`${JSON.stringify({ version: 2, id: 'ari', ok: true, result: { state: 'playing' } })}\n`)
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.listen(sock, () => resolve())
      server.on('error', reject)
    })
    try {
      await expect(
        sendCliampIpc(sock, { method: 'state.get' }, 2_000),
      ).resolves.toMatchObject({ ok: true, result: { state: 'playing' } })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(dir, { recursive: true, force: true })
    }
    },
  )
})
