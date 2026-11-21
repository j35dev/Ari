import { afterEach, expect, it, vi } from 'vitest'
import type { SDKMessage, SDKUserMessage, Options, Query } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from './async-queue'
import { withClaudeQuery } from './claude-driver'

const createQuery = vi.hoisted(() =>
  vi.fn<(input: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Partial<Query>>(),
)
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: createQuery }))
afterEach(() => vi.resetAllMocks())

it('reads metadata without submitting a prompt and closes the SDK query', async () => {
  const stream = new AsyncQueue<SDKMessage>()
  const close = vi.fn(() => stream.end())
  const supportedModels = vi.fn(async () => [
    { value: 'default', displayName: 'CLI default', description: 'Default' },
  ])
  createQuery.mockReturnValue({
    [Symbol.asyncIterator]: () => stream[Symbol.asyncIterator](),
    close,
    supportedModels,
  })
  expect(
    await withClaudeQuery('installed.exe', '/repo', { CLAUDE_CONFIG_DIR: '/account' }, (runtime) =>
      runtime.supportedModels(),
    ),
  ).toEqual([{ value: 'default', displayName: 'CLI default', description: 'Default' }])
  expect(close).toHaveBeenCalledTimes(1)
  expect(createQuery.mock.calls[0]?.[0].options).toMatchObject({
    pathToClaudeCodeExecutable: 'installed.exe',
    strictMcpConfig: true,
    tools: [],
    env: { CLAUDE_CONFIG_DIR: '/account' },
  })
})
