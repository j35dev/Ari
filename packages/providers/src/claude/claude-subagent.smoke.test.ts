import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { expect, it } from 'vitest'
import { findBinary } from '../detector'
import { realDetectEnvironment } from '../types'
import { ClaudeDriver } from './claude-driver'
import { ClaudeSessionPool } from './session-pool'

/** Opt-in: records one real background-subagent session (haiku, scratch folder). */
it.skipIf(process.env['ARI_CLAUDE_SUBAGENT_RECORD'] === undefined)(
  'records a real background Claude subagent session',
  async () => {
    const binary = findBinary('claude', realDetectEnvironment())
    if (!binary) throw new Error('Claude CLI is not installed')
    const cwd = await mkdtemp(join(tmpdir(), 'ari-claude-subagent-'))
    await writeFile(join(cwd, 'alpha.txt'), 'alpha\n')
    await writeFile(join(cwd, 'beta.md'), '# beta\n')
    const pool = new ClaudeSessionPool()
    const recorded: SDKMessage[] = []
    const driver = new ClaudeDriver(binary, {
      pool,
      query: (input) => {
        const runtime = query({
          ...input,
          options: {
            ...input.options,
            tools: ['Agent', 'Task', 'Glob', 'Bash'],
            settingSources: [],
            maxTurns: 8,
            strictMcpConfig: true,
            mcpServers: {},
          },
        })
        return {
          initializationResult: runtime.initializationResult.bind(runtime),
          interrupt: runtime.interrupt.bind(runtime),
          close: runtime.close.bind(runtime),
          stopTask: runtime.stopTask.bind(runtime),
          async *[Symbol.asyncIterator]() {
            for await (const message of runtime) {
              recorded.push(message)
              yield message
            }
          },
        }
      },
    })
    try {
      const adapter = await driver.create({
        sessionId: 'subagent-smoke',
        workspacePath: cwd,
        prompt:
          'Use the Agent tool with run_in_background set to true to have a general-purpose subagent list the files in this folder, then summarise what it found.',
        modelId: 'haiku',
        permissionMode: 'full',
        resumeOf: null,
      })
      for await (const event of adapter.start()) {
        if (event.type === 'error') throw new Error(event.message)
      }
      await adapter.dispose()
      await expect
        .poll(() => recorded.filter((message) => message.type === 'result').length, {
          timeout: 120_000,
          interval: 500,
        })
        .toBeGreaterThanOrEqual(2)
    } finally {
      await pool.shutdownAll()
      await rm(cwd, { recursive: true, force: true })
      const sanitized = recorded.map((message) =>
        message.type === 'system' && message.subtype === 'init'
          ? {
              type: message.type,
              subtype: message.subtype,
              uuid: message.uuid,
              session_id: message.session_id,
              model: message.model,
              permissionMode: message.permissionMode,
              tools: message.tools,
            }
          : message,
      )
      await writeFile(
        process.env['ARI_CLAUDE_SUBAGENT_RECORD']!,
        sanitized.map((message) => JSON.stringify(message)).join('\n') + '\n',
      )
    }
  },
  180_000,
)
