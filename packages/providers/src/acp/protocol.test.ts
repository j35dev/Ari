import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcpUpdateFolder, stopReasonEvents, terminalLoginsFrom } from './protocol'
import type { AcpSessionNotification } from './protocol'

function fixtureLines(name: string): AcpSessionNotification[] {
  const raw = readFileSync(join(__dirname, '__fixtures__', name), 'utf8')
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AcpSessionNotification)
}

describe('AcpUpdateFolder', () => {
  it('folds a full recorded session into deltas, tools, and usage', () => {
    const folder = new AcpUpdateFolder()
    const events = fixtureLines('session-updates.jsonl').flatMap((n) => folder.fold(n))

    expect(events[0]).toEqual({ type: 'thinking-delta', text: 'Let me check the repo layout.' })
    expect(events[1]).toEqual({ type: 'text-delta', text: 'Looking at ' })
    expect(events[2]).toEqual({ type: 'text-delta', text: '**src/** now.' })

    // call_1: started once, completed once with text result.
    const started = events.filter((e) => e.type === 'tool-started')
    expect(started.map((e) => (e as { callId: string }).callId)).toEqual(['call_1', 'call_2'])
    expect(started[0]).toMatchObject({ name: 'read_file' })

    const completed = events.filter((e) => e.type === 'tool-completed')
    expect(completed.length).toBe(2)
    expect(completed[0]).toMatchObject({ callId: 'call_1', isError: false })
    expect(JSON.parse((completed[0] as { resultJson: string }).resultJson)).toEqual({
      text: 'export function main() {}',
    })
    expect(completed[1]).toMatchObject({ callId: 'call_2', isError: true })
    expect(JSON.parse((completed[1] as { resultJson: string }).resultJson)).toEqual({
      diff: { path: 'src/util.ts', oldText: 'a', newText: 'b' },
    })

    // A context-window gauge is not a token count, so it must never reach the
    // transcript's additive usage readout.
    expect(events.some((e) => e.type === 'usage')).toBe(false)

    // plan updates have no transcript surface.
    expect(events.some((e) => e.type === 'error')).toBe(false)
    expect(events.some((e) => e.type === 'done')).toBe(false)
  })

  it('ignores non-terminal bookkeeping updates entirely', () => {
    const folder = new AcpUpdateFolder()
    const events = fixtureLines('non-terminal-updates.jsonl').flatMap((n) => folder.fold(n))
    expect(events).toEqual([{ type: 'text-delta', text: 'Partial progress before the wall.' }])
  })

  it('synthesizes a start when an agent finalizes a tool without creating it', () => {
    const folder = new AcpUpdateFolder()
    const events = folder.fold({
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'late_1',
        status: 'completed',
        rawOutput: { ok: true },
      },
    })
    expect(events.map((e) => e.type)).toEqual(['tool-started', 'tool-completed'])
    expect(JSON.parse((events[1] as { resultJson: string }).resultJson)).toEqual({ ok: true })
  })

  it('drops the context gauge and other malformed payloads', () => {
    const folder = new AcpUpdateFolder()
    expect(
      folder.fold({
        update: { sessionUpdate: 'usage_update', used: 12, size: 100, cost: { amount: 5, currency: 'EUR' } },
      }),
    ).toEqual([])
    expect(folder.fold({})).toEqual([])
    expect(folder.fold({ update: { sessionUpdate: 'from_the_future' } })).toEqual([])
  })

  it('keeps empty text chunks out of the stream', () => {
    const folder = new AcpUpdateFolder()
    expect(
      folder.fold({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } } }),
    ).toEqual([])
  })

  it('does not turn the pi-acp startup prelude into assistant prose', () => {
    const startupInfo = '## Context\n- D:/project/AGENTS.md\n\n## Skills\n- C:/skills/example/SKILL.md\n'
    const folder = new AcpUpdateFolder()
    folder.setStartupInfo(startupInfo)

    expect(
      folder.fold({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: startupInfo } } }),
    ).toEqual([])
    expect(
      folder.fold({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hi.' } } }),
    ).toEqual([{ type: 'text-delta', text: 'Hi.' }])
  })

  it('preserves a real reply that merely resembles the startup prelude', () => {
    const folder = new AcpUpdateFolder()
    folder.setStartupInfo('## Context\n- D:/project/AGENTS.md\n')

    expect(
      folder.fold({ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '## Context\n- D:/project/AGENTS.md\n\nI found it.' } } }),
    ).toEqual([{ type: 'text-delta', text: '## Context\n- D:/project/AGENTS.md\n\nI found it.' }])
  })

  it('surfaces agent error updates instead of swallowing them', () => {
    const folder = new AcpUpdateFolder()
    const events = folder.fold({
      sessionId: 'sess_1',
      update: {
        sessionUpdate: 'error',
        content: [{ type: 'text', text: 'quota exhausted' }],
      },
    })
    if (events[0]?.type === 'error') {
      expect(events[0].message).toBe('quota exhausted')
      expect(JSON.parse(events[0].rawJson ?? '{}')).toMatchObject({ sessionUpdate: 'error' })
    } else {
      throw new Error('expected error event')
    }
  })

  it('gives agent error updates without content a legible fallback message', () => {
    const folder = new AcpUpdateFolder()
    const events = folder.fold({ sessionId: 'sess_1', update: { sessionUpdate: 'error' } })
    if (events[0]?.type === 'error') {
      expect(events[0].message).toContain('sess_1')
      expect(events[0].message).toContain('unspecified error')
    } else {
      throw new Error('expected error event')
    }
  })
})

describe('stopReasonEvents', () => {
  it('maps successful and cancelled turns to done', () => {
    for (const reason of ['end_turn', 'cancelled', 'max_turn_requests']) {
      expect(stopReasonEvents(reason)).toEqual([{ type: 'done' }])
    }
  })

  it('surfaces refusals and token limits as errors before done', () => {
    const refusal = stopReasonEvents('refusal')
    expect(refusal[0]?.type).toBe('error')
    expect(refusal[1]?.type).toBe('done')
    const maxTokens = stopReasonEvents('max_tokens')
    expect(maxTokens[0]?.type).toBe('error')
  })

  it('degrades unknown reasons to a plain done', () => {
    expect(stopReasonEvents('something_new')).toEqual([{ type: 'done' }])
  })
})

describe('terminalLoginsFrom', () => {
  it('keeps only auth methods carrying a runnable terminal-auth argv', () => {
    const logins = terminalLoginsFrom({
      authMethods: [
        {
          id: 'claude-ai-login',
          name: 'Claude Subscription',
          description: 'Use Claude subscription ',
          type: 'terminal',
          _meta: {
            'terminal-auth': {
              command: '/usr/bin/node',
              args: ['adapter.js', '--cli', 'auth', 'login', '--claudeai'],
              label: 'Claude Login',
            },
          },
        },
        // Advertised but unrunnable: no argv for Ari to launch.
        { id: 'gateway', name: 'Custom model gateway' },
      ],
    })

    expect(logins).toEqual([
      {
        methodId: 'claude-ai-login',
        name: 'Claude Subscription',
        description: 'Use Claude subscription',
        command: '/usr/bin/node',
        args: ['adapter.js', '--cli', 'auth', 'login', '--claudeai'],
      },
    ])
  })

  it('falls back to the terminal-auth label, then the id, for a nameless method', () => {
    const [labelled, bare] = terminalLoginsFrom({
      authMethods: [
        { id: 'console-login', _meta: { 'terminal-auth': { command: 'node', label: 'Console Login' } } },
        { id: 'other-login', name: '   ', _meta: { 'terminal-auth': { command: 'node' } } },
      ],
    })
    expect(labelled?.name).toBe('Console Login')
    expect(labelled?.args).toEqual([])
    expect(bare?.name).toBe('other-login')
  })

  it('answers empty for agents that advertise no auth at all', () => {
    expect(terminalLoginsFrom({})).toEqual([])
    expect(terminalLoginsFrom(null)).toEqual([])
  })

  it("reads the registry's type/args shape against the agent's own launch", () => {
    // The `_meta` extension is a stopgap the adapters call one; the registry
    // shape is `args` to whatever command started the agent.
    const result = { authMethods: [{ id: 'pi_terminal_login', name: 'Launch pi', type: 'terminal', args: ['--terminal-login'] }] }
    expect(terminalLoginsFrom(result, { command: 'npx', args: ['-y', 'pi-acp@0.0.33'] })).toEqual([
      {
        methodId: 'pi_terminal_login',
        name: 'Launch pi',
        description: '',
        command: 'npx',
        args: ['-y', 'pi-acp@0.0.33', '--terminal-login'],
      },
    ])
    // Without a launch to append to there is nothing runnable to offer.
    expect(terminalLoginsFrom(result)).toEqual([])
  })

  it('prefers the terminal-auth argv over the registry shape when both are present', () => {
    const [login] = terminalLoginsFrom(
      {
        authMethods: [
          {
            id: 'pi_terminal_login',
            type: 'terminal',
            args: ['--terminal-login'],
            _meta: { 'terminal-auth': { command: 'node', args: ['dist/index.js', '--terminal-login'] } },
          },
        ],
      },
      { command: 'npx', args: ['-y', 'pi-acp@0.0.33'] },
    )
    expect(login).toMatchObject({ command: 'node', args: ['dist/index.js', '--terminal-login'] })
  })
})
