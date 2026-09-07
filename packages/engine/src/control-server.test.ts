import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { AgentControlServer } from './control-server'

it('authenticates session tokens, rejects versions and cancels disconnected requests', async () => {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\ari-test-${randomUUID()}`
      : join(tmpdir(), `ari-${randomUUID()}.sock`)
  let cancelled!: () => void
  const cancellation = new Promise<void>((resolve) => {
    cancelled = resolve
  })
  const server = new AgentControlServer({
    endpoint,
    invoke: async (caller, _method, _params, signal) => {
      signal.addEventListener('abort', cancelled, { once: true })
      return { ok: true, result: { caller } }
    },
  })
  await server.listen()
  const exchange = async (frames: unknown[], count: number): Promise<unknown[]> => {
    const socket = connect(endpoint)
    const replies: unknown[] = []
    try {
      return await new Promise((resolve, reject) => {
        let buffer = ''
        socket.on('error', reject)
        socket.on('connect', () =>
          socket.write(frames.map((f) => JSON.stringify(f)).join('\n') + '\n'),
        )
        socket.on('data', (data) => {
          buffer += data.toString()
          while (buffer.includes('\n')) {
            const end = buffer.indexOf('\n')
            replies.push(JSON.parse(buffer.slice(0, end)) as unknown)
            buffer = buffer.slice(end + 1)
          }
          if (replies.length >= count) resolve(replies)
        })
      })
    } finally {
      socket.destroy()
    }
  }
  try {
    const token = server.tokenFor('root')
    expect(server.tokenFor('root')).toBe(token)
    expect(server.tokenFor('child')).not.toBe(token)
    expect(await exchange([{ type: 'hello', version: 99, token }], 1)).toMatchObject([
      { error: { code: 'protocol_version_mismatch' } },
    ])
    expect(await exchange([{ type: 'hello', version: 1, token: 'invalid' }], 1)).toMatchObject([
      { error: { code: 'unauthorized' } },
    ])
    expect(
      await exchange(
        [
          { type: 'hello', version: 1, token },
          { type: 'request', id: 'r', method: 'runtime.info', params: {} },
        ],
        2,
      ),
    ).toMatchObject([{ type: 'ready' }, { ok: true, result: { caller: 'root' } }])
    await cancellation
    server.revoke('root')
    expect(await exchange([{ type: 'hello', version: 1, token }], 1)).toMatchObject([
      { error: { code: 'unauthorized' } },
    ])
  } finally {
    await server.close()
  }
})
