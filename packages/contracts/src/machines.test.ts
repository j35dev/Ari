import { describe, expect, it } from 'vitest'
import {
  machineEventsFrameSchema,
  machineEventsParamsSchema,
  machineOperationResultSchema,
  machineViewSchema,
} from './machines'
import { remoteSessionResultSchema } from './remote'
import type { SessionSummary } from './rpc'

describe('Machines renderer contracts', () => {
  it('defaults terminal access false independently of public terminal capabilities', () => {
    const view = machineViewSchema.parse({
      id: 'machine_a',
      name: 'A',
      routes: [{ kind: 'tailscale', origin: 'https://a.tailnet.ts.net' }],
      status: 'unpaired',
      identity: { protocolVersion: 1, capabilities: ['terminal.create'] },
      lastSeenAt: null,
      error: null,
    })
    expect(view.allowTerminal).toBe(false)
  })
  it('requires machine and host session scope in streams and preserves complete server messages', () => {
    expect(machineEventsParamsSchema.safeParse({ sessionId: 'same' }).success).toBe(false)
    expect(
      machineEventsFrameSchema.parse({
        machineId: 'A',
        message: { type: 'events.desync', sessionId: 'same', reason: 'replay unavailable' },
      }),
    ).toHaveProperty('message.reason', 'replay unavailable')
    expect(
      machineEventsFrameSchema.safeParse({ machineId: 'A', sessionId: 'same', events: [] }).success,
    ).toBe(false)
  })
  it('preserves named failures and full host session results rather than reducing them to snapshots', () => {
    for (const code of ['not_found', 'conflict', 'unreachable'] as const)
      expect(
        machineOperationResultSchema.parse({ ok: false, error: { code, message: code } }),
      ).toHaveProperty('error.code', code)
    const summary: SessionSummary = {
      id: 'same',
      title: 'A',
      projectId: 'project_A',
      updatedAt: 1,
      messageCount: 1,
    }
    const result = remoteSessionResultSchema.parse({
      session: {
        id: 'same',
        projectId: 'project_A',
        title: 'A',
        driverKind: 'codex',
        modelId: 'mock',
        permissionMode: 'ask',
        status: 'idle',
        createdAt: 1,
        updatedAt: 1,
      },
      summary,
      seq: 2,
      messages: [
        {
          id: 'm',
          sessionId: 'same',
          turnId: null,
          role: 'assistant',
          parts: [{ type: 'text', text: 'history' }],
          createdAt: 1,
        },
      ],
      pendingApprovals: [],
      pendingInputs: [],
      tasks: [],
      parent: { id: 'parent', title: 'Host parent' },
    })
    expect(result.messages[0]?.parts[0]).toEqual({ type: 'text', text: 'history' })
    expect(result.summary).toEqual(summary)
    expect(result.parent).toEqual({ id: 'parent', title: 'Host parent' })
  })
})
