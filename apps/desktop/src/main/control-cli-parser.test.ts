// @vitest-environment node
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cli = createRequire(import.meta.url)('../../resources/cli/ari.cjs') as {
  parse(argv: string[]): { method: string; params: Record<string, unknown> }
}

it('exposes recipient inbox acknowledgement and sender delivery inspection with exact identities', () => {
  expect(cli.parse(['session', 'inbox', '--include-consumed']).params).toEqual({
    includeConsumed: true,
  })
  expect(cli.parse(['session', 'ack', 'message-a', 'message-b', '--key', 'ack']).params).toEqual({
    messageIds: ['message-a', 'message-b'],
    idempotencyKey: 'ack',
  })
  expect(cli.parse(['session', 'delivery', 'recipient', 'message-a'])).toMatchObject({
    method: 'session.delivery',
    params: { targetSessionId: 'recipient', messageId: 'message-a' },
  })
  expect(cli.parse(['parent', 'message', 'Which file?', '--key', 'question'])).toMatchObject({
    method: 'session.message',
    params: { targetSessionId: 'parent', text: 'Which file?', idempotencyKey: 'question' },
  })
})

it('keeps read-only routine list parameters free of mutation keys', () => {
  expect(cli.parse(['task', 'routine.list']).params).toEqual({ sessionId: 'self' })
})

it('preserves multiline file input for assignment and coordination without shell parsing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-cli-text-'))
  try {
    const file = join(dir, 'prompt.txt')
    const text =
      'Implement search.\n\nKeep literal $HOME and `commands` as text.\nUnicode: café → search'
    await writeFile(file, text, 'utf8')
    for (const args of [
      ['session', 'prompt', 'worker'],
      ['session', 'message', 'worker'],
      ['parent', 'message'],
      ['project', 'ask', 'proj_1'],
      ['session', 'spawn', '--title', 'Search', '--agent', 'codex'],
    ]) {
      const parsed = cli.parse([...args, '--prompt-file', file, '--key', 'exact'])
      expect(parsed.params[parsed.method === 'session.spawn' ? 'prompt' : 'text']).toBe(
        await readFile(file, 'utf8'),
      )
    }
    expect(() =>
      cli.parse(['session', 'prompt', 'worker', 'inline', '--prompt-file', file]),
    ).toThrow(/either/)
    const params = join(dir, 'params.json')
    await writeFile(params, JSON.stringify({ title: 'Search', assignment: { goal: text } }))
    expect(cli.parse(['task', 'launch', '--params-file', params]).params.assignment).toEqual({
      goal: text,
    })
    expect(cli.parse(['task', 'inbox']).params).toEqual({ sessionId: 'self' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('parses the Aria commands', () => {
  expect(
    cli.parse(['project', 'ask', 'proj_1', 'Fix login', '--title', 'Web lead', '--key', 'fix']),
  ).toMatchObject({
    method: 'projects.ask',
    params: { projectId: 'proj_1', text: 'Fix login', title: 'Web lead', idempotencyKey: 'fix' },
  })
  expect(
    cli.parse([
      'project',
      'default',
      'proj_1',
      '--agent',
      'claude',
      '--model',
      'opus',
      '--effort',
      'high',
      '--permission',
      'allow-edits',
      '--key',
      'default',
    ]),
  ).toMatchObject({
    method: 'projects.setDefault',
    params: {
      projectId: 'proj_1',
      driverKind: 'claude',
      modelId: 'opus',
      effort: 'high',
      permissionMode: 'allow-edits',
      idempotencyKey: 'default',
    },
  })
  expect(() => cli.parse(['project', 'default', 'proj_1'])).toThrow('--agent')
  expect(() => cli.parse(['project', 'ask'])).toThrow('project id')
  expect(cli.parse(['projects'])).toMatchObject({ method: 'projects.list', params: {} })
  expect(cli.parse(['sessions', 'login', 'bug', '--active', '--project', 'proj_1'])).toEqual(
    expect.objectContaining({
      method: 'sessions.find',
      params: { scope: 'active', query: 'login bug', projectId: 'proj_1' },
    }),
  )
  expect(cli.parse(['sessions', '--query', 'limiter', '--limit', '5']).params).toEqual({
    scope: 'all',
    query: 'limiter',
    limit: 5,
  })
  expect(() => cli.parse(['sessions', 'a', '--query', 'b'])).toThrow('Use either')
  expect(() => cli.parse(['sessions', '--limit', '0'])).toThrow('--limit')
  expect(
    cli.parse([
      'session',
      'spawn',
      '--project',
      'proj_1',
      '--title',
      'Fix login',
      '--agent',
      'claude',
      '--key',
      'k',
    ]).params,
  ).toEqual({ title: 'Fix login', driverKind: 'claude', idempotencyKey: 'k', projectId: 'proj_1' })
})
