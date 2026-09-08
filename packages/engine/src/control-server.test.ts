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
  let requestStarted!: () => void
  const requestEntered = new Promise<void>((resolve) => {
    requestStarted = resolve
  })
  let cancelled!: () => void
  const cancellation = new Promise<void>((resolve) => {
    cancelled = resolve
  })
  const server = new AgentControlServer({
    endpoint,
    invoke: async (caller, _method, _params, signal) => {
      requestStarted()
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          cancelled()
          resolve()
          return
        }
        signal.addEventListener(
          'abort',
          () => {
            cancelled()
            resolve()
          },
          { once: true },
        )
      })
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
  const disconnect = async (frames: unknown[]): Promise<void> => {
    const socket = connect(endpoint)
    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      socket.on('error', reject)
      socket.on('connect', () =>
        socket.write(frames.map((f) => JSON.stringify(f)).join('\n') + '\n'),
      )
      socket.on('data', (data) => {
        buffer += data.toString()
        if (buffer.includes('\n')) resolve()
      })
    })
    socket.destroy()
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
    const disconnected = disconnect([
      { type: 'hello', version: 1, token },
      { type: 'request', id: 'r', method: 'runtime.info', params: {} },
    ])
    await requestEntered
    await disconnected
    await cancellation
    server.revoke('root')
    expect(await exchange([{ type: 'hello', version: 1, token }], 1)).toMatchObject([
      { error: { code: 'unauthorized' } },
    ])
  } finally {
    await server.close()
  }
})

it('rejects excess in-flight requests without closing the socket', async () => {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\ari-test-${randomUUID()}`
      : join(tmpdir(), `ari-${randomUUID()}.sock`)
  const server = new AgentControlServer({
    endpoint,
    requestTimeoutMs: 25,
    maxInFlightRequests: 1,
    invoke: async (_caller, method) => {
      if (method === 'session.get') await new Promise<never>(() => undefined)
      return { ok: true, result: { method } }
    },
  })
  await server.listen()
  const socket = connect(endpoint)
  const replies: unknown[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      let sentAfterTimeout = false
      socket.on('error', reject)
      socket.on('connect', () => {
        const token = server.tokenFor('root')
        socket.write(
          [
            { type: 'hello', version: 1, token },
            {
              type: 'request',
              id: 'hung',
              method: 'session.get',
              params: { targetSessionId: 's' },
            },
            { type: 'request', id: 'excess', method: 'runtime.info', params: {} },
          ]
            .map((frame) => JSON.stringify(frame))
            .join('\n') + '\n',
        )
      })
      socket.on('data', (data) => {
        buffer += data.toString()
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n')
          replies.push(JSON.parse(buffer.slice(0, end)) as unknown)
          buffer = buffer.slice(end + 1)
        }
        if (replies.length === 3 && !sentAfterTimeout) {
          sentAfterTimeout = true
          socket.write(
            `${JSON.stringify({ type: 'request', id: 'after', method: 'runtime.info', params: {} })}\n`,
          )
        }
        if (replies.length === 4) resolve()
      })
    })
    expect(replies).toContainEqual({
      type: 'response',
      id: 'excess',
      ok: false,
      error: { code: 'delegation_limit', message: 'Too many in-flight control requests.' },
    })
    expect(replies).toContainEqual({
      type: 'response',
      id: 'hung',
      ok: false,
      error: { code: 'control_timeout', message: 'Control request timed out.' },
    })
    expect(replies).toContainEqual({
      type: 'response',
      id: 'after',
      ok: true,
      result: { method: 'runtime.info' },
    })
  } finally {
    socket.destroy()
    await server.close()
  }
})

it('times out one request without closing the socket or cancelling its sibling', async () => {
  const endpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\ari-test-${randomUUID()}`
      : join(tmpdir(), `ari-${randomUUID()}.sock`)
  const server = new AgentControlServer({
    endpoint,
    requestTimeoutMs: 25,
    invoke: async (_caller, method, _params, signal) => {
      if (method === 'session.get') {
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        )
      }
      if (method === 'session.wait') {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      return { ok: true, result: { method } }
    },
  })
  await server.listen()
  const socket = connect(endpoint)
  const replies: unknown[] = []
  try {
    await new Promise<void>((resolve, reject) => {
      let buffer = ''
      socket.on('error', reject)
      socket.on('connect', () => {
        const token = server.tokenFor('root')
        socket.write(
          [
            { type: 'hello', version: 1, token },
            {
              type: 'request',
              id: 'slow',
              method: 'session.get',
              params: { targetSessionId: 's' },
            },
            { type: 'request', id: 'fast', method: 'runtime.info', params: {} },
            {
              type: 'request',
              id: 'wait',
              method: 'session.wait',
              params: { targetSessionIds: ['s'], timeoutMs: 100 },
            },
          ]
            .map((frame) => JSON.stringify(frame))
            .join('\n') + '\n',
        )
      })
      socket.on('data', (data) => {
        buffer += data.toString()
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n')
          replies.push(JSON.parse(buffer.slice(0, end)) as unknown)
          buffer = buffer.slice(end + 1)
        }
        if (replies.length === 4) resolve()
      })
    })
    expect(replies).toContainEqual({ type: 'ready', version: 1 })
    expect(replies).toContainEqual({
      type: 'response',
      id: 'fast',
      ok: true,
      result: { method: 'runtime.info' },
    })
    expect(replies).toContainEqual({
      type: 'response',
      id: 'slow',
      ok: false,
      error: { code: 'control_timeout', message: 'Control request timed out.' },
    })
    expect(replies).toContainEqual({
      type: 'response',
      id: 'wait',
      ok: true,
      result: { method: 'session.wait' },
    })
  } finally {
    socket.destroy()
    await server.close()
  }
})
