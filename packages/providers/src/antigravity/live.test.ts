import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentEvent } from '@ari/contracts/agent-event'
import { AcpDriver, acpSessionPool } from '../acp/acp-driver'
import { resolveAcpLaunch } from '../acp/launches'
import type { AdapterSession, ProviderAdapter } from '../driver'

/** Opt in with ARI_REAL_AGY=<installed CLI path>. Uses the CLI's own sign-in and real Gemini quota. */
it.skipIf(!process.env['ARI_REAL_AGY'])(
  'streams edits, delivers system instructions, and resumes AGY',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'ari-agy-live-'))
    const marker = `ari-agy-${randomUUID()}`
    const launch = resolveAcpLaunch('antigravity', { cliBinaryPath: process.env['ARI_REAL_AGY']! })
    expect(launch).not.toBeNull()
    const driver = new AcpDriver('antigravity', launch, null)
    const session: AdapterSession = {
      sessionId: randomUUID(),
      workspacePath: cwd,
      permissionMode: 'ask',
      modelId: null,
      effort: 'low',
      resumeOf: null,
      instructions: `The integration marker is ${marker}. Do not use subagents.`,
      prompt:
        'Create marker.txt containing the integration marker from your system instructions. Use a file edit tool, not a terminal command. Then reply with the marker.',
    }
    let adapter: ProviderAdapter | null = null
    const collect = async (provider: ProviderAdapter): Promise<AgentEvent[]> => {
      const events: AgentEvent[] = []
      for await (const event of provider.start()) {
        events.push(event)
        if (event.type === 'approval-requested')
          provider.respondApproval?.(event.approvalId, 'allow')
        if (event.type === 'input-requested') throw new Error(`Unexpected input: ${event.prompt}`)
      }
      return events
    }
    try {
      adapter = await driver.create(session)
      const first = await collect(adapter)
      expect(first.filter((event) => event.type === 'error')).toEqual([])
      expect(first.some((event) => event.type === 'tool-completed' && !event.isError)).toBe(true)
      expect((await readFile(join(cwd, 'marker.txt'), 'utf8')).trim()).toBe(marker)
      const ref = first.find((event) => event.type === 'session-ref')
      expect(ref?.type).toBe('session-ref')
      if (ref?.type !== 'session-ref') throw new Error('No native conversation to resume')
      await adapter.dispose()
      adapter = null
      await acpSessionPool.shutdownAll()

      adapter = await driver.create({
        ...session,
        resumeOf: ref.ref,
        instructions: 'Do not use subagents or read files.',
        prompt:
          'Without using tools or reading files, recall the integration marker and reply with it.',
      })
      const resumed = await collect(adapter)
      expect(resumed.filter((event) => event.type === 'error')).toEqual([])
      expect(resumed.find((event) => event.type === 'session-ref')).toEqual(ref)
      expect(
        resumed
          .filter((event) => event.type === 'text-delta')
          .map((event) => event.text)
          .join(''),
      ).toContain(marker)
    } finally {
      await adapter?.dispose()
      await acpSessionPool.shutdownAll()
      await rm(cwd, { recursive: true, force: true })
    }
  },
  120_000,
)
