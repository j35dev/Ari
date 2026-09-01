import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { AriCoreDriver } from './ari-core-driver'
import { MemoryConversationStore } from './conversation-store'
import { EndpointStore } from './endpoints'

/**
 * End-to-end exercise of the harness against a real temp workspace: a scripted
 * endpoint plays the trajectory a model actually takes — orient, search, read,
 * edit, verify — and every tool runs for real against the filesystem. This is
 * the test that would have caught a harness whose tools could not work a
 * repository even with every unit test green.
 */
async function scriptedRun(
  dir: string,
  script: { name: string; args: unknown }[],
): Promise<{ events: AgentEvent[]; systemPrompts: string[] }> {
  const endpoints = new EndpointStore({ dir })
  await endpoints.upsert({
    id: 'ep',
    name: 'Fake',
    baseUrl: 'http://fake/v1',
    flavor: 'openai-chat',
    model: 'm',
    headers: {},
  })
  const systemPrompts: string[] = []
  let round = 0
  const driver = new AriCoreDriver(endpoints, {
    conversations: new MemoryConversationStore(),
    clients: {
      openai: async function* (request) {
        systemPrompts.push(request.messages[0]?.content ?? '')
        const step = script[round]
        round++
        if (step) {
          yield {
            type: 'tool-started',
            callId: `c${round}`,
            name: step.name,
            argsJson: JSON.stringify(step.args),
          }
        } else {
          yield { type: 'text-delta', text: 'finished' }
        }
        yield { type: 'done' }
      },
    },
  })
  const adapter = await driver.create({
    sessionId: 'e2e',
    workspacePath: dir,
    prompt: 'bump the answer to 42',
    modelId: 'ep:ep',
    permissionMode: 'full',
    resumeOf: null,
  })
  const events: AgentEvent[] = []
  for await (const event of adapter.start()) events.push(event)
  return { events, systemPrompts }
}

describe('ari core harness end to end', () => {
  it('orients, searches, reads, edits and verifies a real workspace', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-e2e-'))
    try {
      await mkdir(join(dir, 'src'), { recursive: true })
      await writeFile(join(dir, 'AGENTS.md'), 'Never use var.', 'utf8')
      await writeFile(join(dir, 'src', 'app.ts'), 'export const answer = 41\n', 'utf8')

      const { events, systemPrompts } = await scriptedRun(dir, [
        { name: 'ls', args: {} },
        { name: 'grep', args: { pattern: 'answer = \\d+', glob: '*.ts' } },
        { name: 'read', args: { path: 'src/app.ts' } },
        { name: 'edit', args: { path: 'src/app.ts', edits: [{ oldText: '41', newText: '42' }] } },
      ])

      const completed = events.filter(
        (e): e is Extract<AgentEvent, { type: 'tool-completed' }> => e.type === 'tool-completed',
      )
      expect(completed.map((e) => e.isError)).toEqual([false, false, false, false])
      // ls sees the tree, grep finds the line, read returns the source.
      expect(completed[0]?.resultJson).toContain('src/')
      expect(completed[0]?.resultJson).toContain('AGENTS.md')
      expect(completed[1]?.resultJson).toContain('src/app.ts:1:')
      expect(completed[2]?.resultJson).toContain('answer = 41')
      // The edit landed on disk, not just in the transcript.
      expect(await readFile(join(dir, 'src', 'app.ts'), 'utf8')).toBe(
        'export const answer = 42\n',
      )
      // And the model was told where it is and what the project asks of it.
      expect(systemPrompts[0]).toContain(dir.replace(/\\/g, '/'))
      expect(systemPrompts[0]).toContain('Never use var.')
      expect(events.at(-1)).toEqual({ type: 'done' })
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('reports a failing command instead of passing it off as success', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-e2e-fail-'))
    try {
      const failing = process.platform === 'win32' ? 'exit /b 7' : 'exit 7'
      const { events } = await scriptedRun(dir, [{ name: 'bash', args: { command: failing } }])
      const completed = events.find(
        (e): e is Extract<AgentEvent, { type: 'tool-completed' }> => e.type === 'tool-completed',
      )
      expect(completed?.resultJson).toContain('exited with code 7')
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  it('hands a failed tool call back to the model as an error, not a crash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-e2e-err-'))
    try {
      const { events } = await scriptedRun(dir, [
        { name: 'read', args: { path: '../outside.txt' } },
        { name: 'ls', args: {} },
      ])
      const completed = events.filter(
        (e): e is Extract<AgentEvent, { type: 'tool-completed' }> => e.type === 'tool-completed',
      )
      expect(completed[0]?.isError).toBe(true)
      expect(completed[0]?.resultJson).toContain('escapes workspace')
      // The turn continues: a rejected call is feedback, not a stopped run.
      expect(completed[1]?.isError).toBe(false)
      expect(events.at(-1)).toEqual({ type: 'done' })
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })
})
