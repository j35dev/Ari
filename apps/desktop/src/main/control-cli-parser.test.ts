// @vitest-environment node
import { createRequire } from 'node:module'
import { expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const cli = createRequire(import.meta.url)('../../resources/cli/ari.cjs') as {
  parse(argv: string[]): { method: string; params: Record<string, unknown> }
}

it('passes explicit root worktree selection through project session spawn', () => {
  expect(
    cli.parse([
      'session',
      'spawn',
      '--project',
      'project',
      '--title',
      'Parallel',
      '--workspace',
      'isolated',
    ]),
  ).toMatchObject({
    method: 'session.spawn',
    params: { projectId: 'project', workspaceMode: 'isolated' },
  })
})

it.each([
  [
    'session',
    'spawn',
    '--title',
    'Search',
    '--project',
    'project',
    '--agent',
    'codex',
    '--model',
    'sol',
    '--effort',
    'auto',
    '--permission',
    'full',
  ],
  [
    'project',
    'ask',
    'project',
    'Implement search',
    '--agent',
    'codex',
    '--model',
    'sol',
    '--effort',
    'xhigh',
    '--permission',
    'ask',
  ],
  ['project', 'lead', 'project', '--agent', 'codex', '--model', 'sol', '--effort', 'auto'],
])('passes launch reasoning and explicit choices through the CLI: %j', (...argv) => {
  const parsed = cli.parse(argv)
  expect(parsed.params.driverKind).toBe('codex')
  expect(parsed.params.modelId).toBe('sol')
  expect(parsed.params.effort).toBe(argv.includes('xhigh') ? 'xhigh' : 'auto')
  if (argv.includes('--permission')) expect(parsed.params.permissionMode).toBe(argv.at(-1))
})

it('reads whole selected turns up to the existing message cap, with explicit tails taking precedence', () => {
  expect(cli.parse(['session', 'read', 'worker', '--turns', '1'])).toMatchObject({
    method: 'session.read',
    params: { targetSessionId: 'worker', tailTurns: 1, tailMessages: 200 },
  })
  for (const args of [
    ['--turns', '1', '--tail', '3'],
    ['--tail', '3', '--turns', '1'],
  ]) {
    expect(cli.parse(['session', 'read', 'worker', ...args]).params).toEqual({
      targetSessionId: 'worker',
      tailTurns: 1,
      tailMessages: 3,
    })
  }
  expect(cli.parse(['session', 'read', 'worker']).params).toEqual({ targetSessionId: 'worker' })
})

it('parses only the compact explicit navigation commands and preserves their keys', () => {
  for (const [args, target] of [
    [['session', 'exact'], { view: 'session', sessionId: 'exact' }],
    [['aria'], { view: 'aria' }],
    [['settings'], { view: 'settings' }],
    [['changes', '--project', 'p'], { view: 'changes', projectId: 'p' }],
    [['changes', '--session', 's'], { view: 'changes', sessionId: 's' }],
  ] as const)
    expect(cli.parse(['app', 'open', ...args, '--key', 'stable'])).toMatchObject({
      method: 'app.open',
      params: { ...target, idempotencyKey: 'stable' },
    })
  for (const args of [
    ['session'],
    ['session', 's', 'extra'],
    ['changes'],
    ['changes', '--project', 'p', '--session', 's'],
    ['settings', '--project', 'p'],
    ['aria', 'old'],
    ['settings', '--model', 'm'],
    ['url', 'https://example.com'],
  ])
    expect(() => cli.parse(['app', 'open', ...args])).toThrow()
})

it('parses project creation with an optional absolute folder and retry key', () => {
  expect(
    cli.parse(['project', 'create', '--name', 'Garden planner', '--key', 'garden']),
  ).toMatchObject({
    method: 'projects.create',
    params: { name: 'Garden planner', idempotencyKey: 'garden' },
  })
  expect(
    cli.parse([
      'project',
      'create',
      '--name',
      'Garden',
      '--path',
      'D:\\Projects\\garden',
      '--key',
      'adopt',
    ]).params,
  ).toEqual({
    name: 'Garden',
    path: 'D:\\Projects\\garden',
    idempotencyKey: 'adopt',
  })
  expect(() => cli.parse(['project', 'create'])).toThrow('needs --name')
  expect(() => cli.parse(['project', 'create', '--name', '  '])).toThrow('needs --name')
  expect(() => cli.parse(['project', 'create', 'folder', '--name', 'Garden'])).toThrow('Use --path')
})

it('passes a follow-up effort override without changing coordination messages', () => {
  expect(
    cli.parse(['session', 'prompt', 'worker', 'Investigate regression', '--effort', 'auto']).params,
  ).toMatchObject({ effort: 'auto', text: 'Investigate regression' })
  expect(cli.parse(['session', 'message', 'worker', 'Use the cache']).params).not.toHaveProperty(
    'effort',
  )
})

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

it('parses lead switches and resets, refusing ambiguous or incomplete choices', () => {
  expect(
    cli.parse([
      'project',
      'lead',
      'proj_1',
      '--agent',
      'codex',
      '--model',
      'gpt',
      '--effort',
      'high',
      '--key',
      'switch',
    ]),
  ).toMatchObject({
    method: 'projects.lead',
    params: {
      projectId: 'proj_1',
      driverKind: 'codex',
      modelId: 'gpt',
      effort: 'high',
      idempotencyKey: 'switch',
    },
  })
  expect(cli.parse(['project', 'lead', 'proj_1', '--reset', '--key', 'reset'])).toMatchObject({
    method: 'projects.lead',
    params: { projectId: 'proj_1', reset: true, idempotencyKey: 'reset' },
  })
  expect(() => cli.parse(['project', 'lead', '--reset'])).toThrow('project id')
  expect(() => cli.parse(['project', 'lead', 'proj_1'])).toThrow('--agent or --reset')
  expect(() => cli.parse(['project', 'lead', 'proj_1', '--agent', 'codex'])).toThrow('--model')
  expect(() => cli.parse(['project', 'lead', 'proj_1', '--reset', '--agent', 'codex'])).toThrow(
    'either',
  )
  expect(() => cli.parse(['project', 'lead', 'proj_1', '--reset', '--model', 'gpt'])).toThrow(
    'either',
  )
  expect(() =>
    cli.parse(['project', 'lead', 'proj_1', '--agent', 'codex', '--permission', 'full']),
  ).toThrow('permissions')
})

it('parses direct project sessions without an agent and session switching', () => {
  expect(
    cli.parse([
      'session',
      'spawn',
      '--project',
      'proj_1',
      '--title',
      'Research',
      '--key',
      'research',
    ]),
  ).toMatchObject({
    method: 'session.spawn',
    params: { projectId: 'proj_1', title: 'Research', idempotencyKey: 'research' },
  })
  expect(
    cli.parse([
      'session',
      'switch',
      'session_1',
      '--agent',
      'codex',
      '--model',
      'gpt',
      '--effort',
      'high',
      '--key',
      'switch',
    ]),
  ).toMatchObject({
    method: 'session.switch',
    params: {
      targetSessionId: 'session_1',
      driverKind: 'codex',
      modelId: 'gpt',
      effort: 'high',
      idempotencyKey: 'switch',
    },
  })
  expect(() => cli.parse(['session', 'switch', '--agent', 'codex'])).toThrow('session id')
  expect(() => cli.parse(['session', 'switch', 'session_1'])).toThrow('--agent')
  expect(() => cli.parse(['session', 'switch', 'session_1', '--agent', 'codex'])).toThrow('--model')
  expect(() =>
    cli.parse(['session', 'spawn', '--project', 'proj_1', '--read-only', 'true']),
  ).toThrow('Unknown option')
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
  expect(() => cli.parse(['project', 'default', 'proj_1', '--agent', 'claude'])).toThrow('--model')
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
