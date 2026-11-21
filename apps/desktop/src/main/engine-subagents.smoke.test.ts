// @vitest-environment node
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { expect, it, vi } from 'vitest'
import { journalEventSchema, type JournalEvent } from '@ari/contracts/events'
import { ClaudeDriver, ClaudeSessionPool } from '@ari/providers/claude'
import { findBinary } from '@ari/providers/detector'
import { DriverRegistry } from '@ari/providers/registry'
import { realDetectEnvironment } from '@ari/providers/types'
import { SessionStore } from '@ari/engine/session-store'
import { Engine } from './engine'

/**
 * Opt-in (ARI_CLAUDE_SUBAGENT_SMOKE=1): one real haiku turn through the engine
 * that makes Claude use a subagent, in a scratch folder with only the tools it
 * needs. Checks the journal keeps the subagent's work out of the parent's.
 */
it.skipIf(process.env['ARI_CLAUDE_SUBAGENT_SMOKE'] !== '1')(
  'keeps a real Claude subagent’s work in its own transcript',
  async () => {
    const binary = findBinary('claude', realDetectEnvironment())
    if (!binary) throw new Error('Claude CLI is not installed')
    const cwd = await mkdtemp(join(tmpdir(), 'ari-subagent-smoke-'))
    const root = await mkdtemp(join(tmpdir(), 'ari-subagent-journal-'))
    await writeFile(join(cwd, 'alpha.txt'), 'alpha\n')
    await writeFile(join(cwd, 'beta.md'), '# beta\n')
    const sessionId = 'sess_subagent_smoke'
    const store = new SessionStore({ rootDir: root })
    await store.append(sessionId, {
      type: 'session.created',
      session: {
        id: sessionId,
        projectId: cwd,
        title: 'Subagent smoke',
        driverKind: 'claude',
        modelId: 'haiku',
        permissionMode: 'full',
        status: 'idle',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    })
    const pool = new ClaudeSessionPool()
    const registry = new DriverRegistry()
    registry.register(
      new ClaudeDriver(binary, {
        pool,
        query: (input) =>
          query({
            ...input,
            options: {
              ...input.options,
              tools: ['Agent', 'Task', 'Bash', 'Glob'],
              settingSources: [],
              maxTurns: 8,
              strictMcpConfig: true,
              mcpServers: {},
            },
          }),
      }),
    )
    const published: JournalEvent[] = []
    const engine = new Engine({
      store,
      registry,
      publish: (_id, event) => published.push(event),
      git: { captureCheckpoint: async () => ({ ok: true, value: null }) },
      resolveWorkspace: async (projectId) => projectId,
      backgroundAdapter: (id) => pool.controls(id),
    })
    pool.onBackground = (id, events) => engine.recordBackground(id, events)
    try {
      await engine.dispatch({
        type: 'turn.start',
        sessionId,
        text: 'Use the Task tool to have a subagent list the files in this folder, then summarise.',
        attachments: [],
      })
      await vi.waitFor(async () => expect((await store.load(sessionId)).lastTurn).toBeDefined(), {
        timeout: 150_000,
        interval: 500,
      })
      const model = await store.load(sessionId)
      const parentCalls = model.messages.flatMap((message) =>
        message.parts.flatMap((part) => (part.type === 'tool-call' ? [part.name] : [])),
      )
      const subagentEvents = published.filter(
        (event): event is Extract<JournalEvent, { type: 'background.task.parts.appended' }> =>
          event.type === 'background.task.parts.appended',
      )
      const subagentCalls = subagentEvents.flatMap((event) =>
        event.parts.flatMap((part) => (part.type === 'tool-call' ? [part.name] : [])),
      )
      const task = model.backgroundTasks?.find((entry) => entry.kind === 'subagent')
      const report = {
        stopReason: model.lastTurn?.stopReason,
        parentActive: model.activeTurnId,
        parentStatus: model.status,
        parentCalls,
        subagentCalls,
        subagentTaskIds: [...new Set(subagentEvents.map((event) => event.taskId))],
        task: task && {
          id: task.id,
          status: task.status,
          label: task.label,
          subagentType: task.subagentType,
          model: task.model,
          prompt: task.prompt?.slice(0, 120),
          result: task.result?.slice(0, 200),
        },
        reply: model.messages
          .flatMap((message) =>
            message.role === 'assistant'
              ? message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : []))
              : [],
          )
          .join('')
          .slice(0, 400),
        journalValid: published.every((event) => journalEventSchema.safeParse(event).success),
      }
      if (process.env['ARI_CLAUDE_SUBAGENT_REPORT'])
        await writeFile(process.env['ARI_CLAUDE_SUBAGENT_REPORT'], JSON.stringify(report, null, 2))
      expect(report.stopReason).toBe('completed')
      expect(report.parentActive).toBeNull()
      expect(parentCalls.every((name) => name === 'Agent' || name === 'Task')).toBe(true)
      expect(parentCalls.length).toBeGreaterThan(0)
      expect(subagentCalls.length).toBeGreaterThan(0)
      expect(report.subagentTaskIds).toEqual([task?.id])
      expect(report.journalValid).toBe(true)
    } finally {
      await engine.shutdown(() => pool.shutdownAll())
      await store.closeJournal(sessionId)
      await rm(cwd, { recursive: true, force: true, maxRetries: 5 })
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    }
  },
  180_000,
)
