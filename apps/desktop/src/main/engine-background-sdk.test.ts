// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { DriverRegistry } from '@ari/providers/registry'
import { SessionStore } from '@ari/engine/session-store'
import { Engine } from './engine'

const scratch: string[] = []
afterEach(async () => {
  for (const dir of scratch.splice(0))
    await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

it('journals SDK background usage and routes approvals and questions to a parked query', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-sdk-background-'))
  scratch.push(dir)
  const store = new SessionStore({ rootDir: dir })
  const sessionId = 'sess_sdk_background'
  await store.append(sessionId, {
    type: 'session.created',
    session: {
      id: sessionId,
      projectId: 'adhoc',
      title: 'SDK background',
      driverKind: 'claude',
      modelId: null,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  })
  const respondApproval = vi.fn()
  const respondInput = vi.fn()
  const engine = new Engine({
    store,
    registry: new DriverRegistry(),
    publish: () => undefined,
    backgroundAdapter: () => ({ respondApproval, respondInput }),
    autoApprove: (request) => (request.toolName === 'Bash' ? 'allow' : null),
  })
  engine.recordBackground(sessionId, [
    {
      type: 'approval-requested',
      approvalId: 'control',
      toolName: 'Bash',
      summaryJson: '{"command":"ari status"}',
      options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
    },
    { type: 'text-delta', text: 'Background research complete.' },
    { type: 'usage', inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, costUsd: 0.01 },
    { type: 'context-usage', usedTokens: 15, windowTokens: 200_000 },
    { type: 'notice', message: 'Claude usage warning' },
    {
      type: 'approval-requested',
      approvalId: 'approval',
      toolName: 'Write',
      summaryJson: '{}',
      options: [{ optionId: 'allow', name: 'Allow once', kind: 'allow_once' }],
    },
    { type: 'input-requested', inputId: 'input', prompt: 'Which file?', choicesJson: null },
  ])
  await vi.waitFor(async () => {
    const model = await store.load(sessionId)
    expect(
      model.pendingApprovals.find((approval) => approval.approvalId === 'approval'),
    ).toBeDefined()
    expect(model.pendingInputs.find((input) => input.inputId === 'input')).toBeDefined()
    expect(model.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, costUsd: 0.01 })
    expect(
      model.messages.some((message) =>
        message.parts.some(
          (part) => part.type === 'text' && part.text.includes('Background research complete.'),
        ),
      ),
    ).toBe(true)
  })
  expect(engine.liveCapabilities(sessionId)).toEqual({
    approval: true,
    question: true,
    steer: false,
  })
  expect(respondApproval).toHaveBeenCalledWith('control', { optionId: 'allow' })
  expect(
    (
      await engine.dispatch({
        type: 'approval.respond',
        sessionId,
        approvalId: 'approval',
        optionId: 'allow',
      })
    ).accepted,
  ).toBe(true)
  expect(respondApproval).toHaveBeenCalledWith('approval', { optionId: 'allow' })
  expect(
    (
      await engine.dispatch({
        type: 'input.respond',
        sessionId,
        inputId: 'input',
        value: 'Desktop',
      })
    ).accepted,
  ).toBe(true)
  expect(respondInput).toHaveBeenCalledWith('input', 'Desktop')
  await engine.shutdown()
})
