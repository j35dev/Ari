import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  getProviderCapabilities,
  UNKNOWN_PROVIDER_CAPABILITIES,
  ONE_SHOT_PROVIDER_CAPABILITIES,
} from './driver'
import type { AdapterSession, Driver, ProviderAdapter } from './driver'
import { CodexDriver } from './codex/codex-driver'
import { ClaudeDriver } from './claude/claude-driver'
import { PiDriver } from './pi/pi-driver'
import { OpencodeDriver } from './opencode/opencode-driver'
import { GrokDriver } from './grok/grok-driver'
import { HermesDriver } from './hermes/hermes-driver'
import { AcpDriver } from './acp/acp-driver'
import type * as SpawnCliModule from './spawn-cli'

vi.mock('./spawn-cli', async (importOriginal) => ({
  ...(await importOriginal<typeof SpawnCliModule>()),
  spawnCli: () => ({
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    killed: false,
    kill: () => true,
    on: () => undefined,
  }),
}))

const SESSION: AdapterSession = {
  sessionId: 'test',
  workspacePath: '/w',
  prompt: 'test',
  modelId: null,
  resumeOf: null,
  permissionMode: 'ask',
}

describe('provider capability discovery', () => {
  it('does not infer support from optional control method names', () => {
    const adapter: ProviderAdapter = {
      start: async function* () {},
      interrupt: () => {},
      dispose: async () => {},
      steer: () => true,
      respondApproval: () => {},
    }
    expect(getProviderCapabilities(adapter)).toEqual(UNKNOWN_PROVIDER_CAPABILITIES)
    expect(getProviderCapabilities({ kind: 'codex' } as Driver).nativeChildren).toMatchObject({
      inspect: false,
      message: false,
      stop: false,
      approvals: false,
    })
    // A consumer cannot mutate defaults or another consumer's discovery.
    const copied = getProviderCapabilities(adapter)
    copied.nativeChildren.message = true
    expect(getProviderCapabilities(adapter).nativeChildren.message).toBe(false)
  })

  it.each([
    new PiDriver('/bin/pi'),
    new OpencodeDriver('/bin/opencode'),
    new GrokDriver('/bin/grok'),
    new HermesDriver('/bin/hermes'),
    new CodexDriver('/bin/codex', { probe: null }),
  ])('declares the actual one-shot adapter controls for $kind', async (driver) => {
    const adapter = await driver.create(SESSION)
    expect(getProviderCapabilities(driver)).toEqual(ONE_SHOT_PROVIDER_CAPABILITIES)
    expect(getProviderCapabilities(adapter)).toEqual(ONE_SHOT_PROVIDER_CAPABILITIES)
    expect(adapter.steer === undefined).toBe(true)
    expect(adapter.respondApproval === undefined).toBe(true)
    expect(adapter.respondInput === undefined).toBe(true)
  })

  it('reports Claude stream controls and no native child or continuity controls', async () => {
    const driver = new ClaudeDriver('/bin/claude')
    const adapter = await driver.create(SESSION)
    expect(getProviderCapabilities(adapter)).toMatchObject({
      steering: 'live',
      liveResponses: 'approvals',
      responsesAfterReconnect: false,
      processContinuity: 'turn-only',
      nativeFork: false,
      nativeHandoff: false,
      nativeChildren: { visibility: false, inspect: false, message: false, stop: false },
    })
    expect(getProviderCapabilities(driver)).toEqual(getProviderCapabilities(adapter))
    expect(typeof adapter.steer).toBe('function')
    expect(typeof adapter.respondApproval).toBe('function')
  })

  it('keeps undecided transports unknown and delegates known ACP fallback discovery', () => {
    const codex = new CodexDriver('/bin/codex')
    expect(getProviderCapabilities(codex)).toEqual(UNKNOWN_PROVIDER_CAPABILITIES)
    const legacy = new PiDriver('/bin/pi')
    const acpWithFallbackOnly = new AcpDriver('pi', null, legacy)
    expect(getProviderCapabilities(acpWithFallbackOnly)).toEqual(ONE_SHOT_PROVIDER_CAPABILITIES)
    const acpMayFallBack = new AcpDriver(
      'pi',
      { label: 'agent', command: 'fake', args: [] },
      legacy,
    )
    expect(getProviderCapabilities(acpMayFallBack)).toEqual(UNKNOWN_PROVIDER_CAPABILITIES)
  })
})
