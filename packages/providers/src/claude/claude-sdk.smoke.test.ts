import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { query, type SDKMessage, type SpawnedProcess } from '@anthropic-ai/claude-agent-sdk'
import { expect, it } from 'vitest'
import { findBinary } from '../detector'
import { realDetectEnvironment } from '../types'
import { ClaudeDriver } from './claude-driver'
import { ClaudeSessionPool } from './session-pool'
import { probeClaudeCatalog } from './catalog'

/** Opt-in live login check. No API keys; tools disabled and scratch cwd only. */
it.skipIf(process.env['ARI_CLAUDE_SDK_SMOKE'] !== '1')(
  'streams two real turns through one installed Claude query',
  async () => {
    const binary = findBinary('claude', realDetectEnvironment())
    if (!binary) throw new Error('Claude CLI is not installed')
    const cwd = await mkdtemp(join(tmpdir(), 'ari-claude-sdk-smoke-'))
    const pool = new ClaudeSessionPool()
    const recorded: SDKMessage[] = []
    const report: unknown[] = []
    const children: SpawnedProcess[] = []
    let queryCount = 0
    const driver = new ClaudeDriver(binary, {
      pool,
      query: (input) => {
        queryCount++
        const runtime = query({
          ...input,
          options: {
            ...input.options,
            tools: ['Bash'],
            settingSources: [],
            maxTurns: 5,
            settings: { permissions: { ask: ['Bash(*)'] } },
            strictMcpConfig: true,
            mcpServers: {},
            spawnClaudeCodeProcess: (options) => {
              const child = input.options.spawnClaudeCodeProcess!(options)
              children.push(child)
              return child
            },
          },
        })
        return {
          initializationResult: runtime.initializationResult.bind(runtime),
          usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:
            runtime.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET.bind(runtime),
          interrupt: runtime.interrupt.bind(runtime),
          close: runtime.close.bind(runtime),
          async *[Symbol.asyncIterator]() {
            for await (const message of runtime) {
              recorded.push(message)
              yield message
            }
          },
        }
      },
    })
    let ref: string | null = null
    let steeredReply = ''
    pool.onBackground = (_id, events) => {
      for (const event of events) {
        if (event.type === 'text-delta') steeredReply += event.text
        if (event.type === 'approval-requested')
          pool.controls('smoke')?.respondApproval?.(event.approvalId, 'allow')
      }
    }
    try {
      const catalog = await probeClaudeCatalog(binary, cwd, { ...process.env })
      report.push({
        scenario: 'catalog',
        models: catalog.models.map((model) => model.id),
        efforts: catalog.efforts.options.map((effort) => effort.id),
      })
      expect(catalog.models.some((model) => model.id === 'default')).toBe(true)
      for (let turn = 1; turn <= 2; turn++) {
        const adapter = await driver.create({
          sessionId: 'smoke',
          workspacePath: cwd,
          prompt: 'Reply with exactly OK.',
          modelId: process.env['ARI_CLAUDE_SDK_SMOKE_MODEL'] ?? 'haiku',
          permissionMode: 'ask',
          resumeOf: ref,
        })
        let text = '',
          deltas = 0,
          done = false
        const errors: string[] = []
        for await (const event of adapter.start()) {
          if (event.type === 'text-delta') {
            text += event.text
            deltas++
          }
          if (event.type === 'session-ref') ref = event.ref
          if (event.type === 'error') errors.push(event.message)
          if (event.type === 'done') done = true
        }
        await adapter.dispose()
        report.push({
          turn,
          text,
          deltas,
          done,
          errors,
          queryCount,
          kept: adapter.keepsBackgroundWork?.(),
        })
        expect(errors).toEqual([])
        expect(text.trim()).toBe('OK')
        expect(deltas).toBeGreaterThan(0)
        expect(done).toBe(true)
        expect(queryCount).toBe(1)
      }
      const simpleRecording = [...recorded]
      const approved = await driver.create({
        sessionId: 'smoke',
        workspacePath: cwd,
        prompt: 'Use Bash to run exactly printf ARI_SDK_APPROVAL. After the command reply briefly.',
        modelId: 'haiku',
        permissionMode: 'ask',
        resumeOf: ref,
      })
      let approvals = 0,
        steerAccepted = false,
        approvalText = ''
      for await (const event of approved.start()) {
        if (event.type === 'text-delta') approvalText += event.text
        if (event.type === 'approval-requested') {
          approvals++
          if (!steerAccepted)
            steerAccepted = await approved.steer!(
              'Also include the exact word STEERED in your reply.',
            )
          approved.respondApproval!(event.approvalId, 'allow')
        }
        if (event.type === 'error') throw new Error(event.message)
      }
      await approved.dispose()
      await expect.poll(() => approvalText + steeredReply, { timeout: 30_000 }).toContain('STEERED')
      expect(approvals).toBeGreaterThan(0)
      expect(steerAccepted).toBe(true)
      report.push({
        scenario: 'approval-and-live-steer',
        approvals,
        steerAccepted,
        text: approvalText + steeredReply,
        queryCount,
      })

      const stopped = await driver.create({
        sessionId: 'smoke',
        workspacePath: cwd,
        prompt: 'Use Bash to run exactly sleep 30. Then reply OK.',
        modelId: 'haiku',
        permissionMode: 'ask',
        resumeOf: ref,
      })
      let interrupted = false,
        stopReason: string | undefined
      for await (const event of stopped.start()) {
        if (event.type === 'tool-started' && event.name === 'Bash' && !interrupted) {
          stopped.interrupt()
          interrupted = true
        }
        if (event.type === 'approval-requested' && !interrupted) {
          stopped.respondApproval!(event.approvalId, 'allow')
          stopped.interrupt()
          interrupted = true
        }
        if (event.type === 'done') stopReason = event.stopReason
      }
      await stopped.dispose()
      expect(interrupted).toBe(true)
      expect(stopReason).toBe('interrupted')
      report.push({ scenario: 'interrupt', interrupted, stopReason, queryCount })

      await pool.shutdownAll()
      const resumed = await driver.create({
        sessionId: 'smoke',
        workspacePath: cwd,
        prompt:
          'What was the exact ARI_ marker from the earlier printf command? Reply only with that marker.',
        modelId: 'haiku',
        permissionMode: 'ask',
        resumeOf: ref,
      })
      let resumedText = '',
        resumedRef: string | null = null
      for await (const event of resumed.start()) {
        if (event.type === 'text-delta') resumedText += event.text
        if (event.type === 'session-ref') resumedRef = event.ref
        if (event.type === 'error') throw new Error(event.message)
      }
      await resumed.dispose()
      expect(resumedText.trim()).toBe('ARI_SDK_APPROVAL')
      expect(resumedRef).toBe(ref)
      report.push({
        scenario: 'cold-resume',
        text: resumedText,
        sameSession: resumedRef === ref,
        queryCount,
      })
      if (process.env['ARI_CLAUDE_SDK_RECORD']) {
        // Init includes local paths/settings inventory; keep only event-mapping fields.
        const sanitized = simpleRecording.map((message) =>
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
          process.env['ARI_CLAUDE_SDK_RECORD'],
          sanitized.map((message) => JSON.stringify(message)).join('\n') + '\n',
        )
      }
    } finally {
      await pool.shutdownAll()
      await rm(cwd, { recursive: true, force: true })
    }
    expect(children.length).toBe(queryCount)
    const childClosed = children.every(
      (child) => child.exitCode != null || child.signalCode != null,
    )
    expect(childClosed).toBe(true)
    if (process.env['ARI_CLAUDE_SDK_REPORT'])
      await writeFile(
        process.env['ARI_CLAUDE_SDK_REPORT'],
        JSON.stringify({ turns: report, queryCount, childClosed }, null, 2),
      )
  },
  120_000,
)
