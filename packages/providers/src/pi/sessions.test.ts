import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listPiSessions, piCwdFolder, piSessionsDir, readPiTranscript } from './sessions'
import type { DetectEnvironment } from '../types'

const FIXTURE = join(__dirname, '__fixtures__', 'session-tree.jsonl')

const ENV: DetectEnvironment = {
  platform: 'linux',
  pathEnv: '/usr/bin',
  homeDir: '/home/tester',
  vars: {},
}

describe('piSessionsDir', () => {
  it('prefers the session-dir override, then the agent dir, then the default', () => {
    expect(piSessionsDir({ ...ENV, vars: { PI_CODING_AGENT_SESSION_DIR: '/s' } })).toBe('/s')
    expect(piSessionsDir({ ...ENV, vars: { PI_CODING_AGENT_DIR: '/a' } })).toBe(
      join('/a', 'sessions'),
    )
    expect(piSessionsDir(ENV)).toBe(join('/home/tester', '.pi', 'agent', 'sessions'))
    expect(piSessionsDir({ ...ENV, homeDir: '' })).toBeNull()
  })
})

describe('piCwdFolder', () => {
  it("matches pi's own encoding, colon included", () => {
    // Verified against real folders written by pi 0.84.4.
    expect(piCwdFolder('D:\\Projects\\Ari')).toBe('--D--Projects-Ari--')
    expect(piCwdFolder('C:\\Users\\user')).toBe('--C--Users-user--')
    expect(piCwdFolder('/home/u/proj')).toBe('---home-u-proj--')
  })
})

describe('readPiTranscript', () => {
  it('walks the active branch and leaves the abandoned one out', async () => {
    const transcript = await readPiTranscript(FIXTURE)
    expect(transcript).not.toBeNull()
    // Two assistant replies share a parent; only the newer one is the branch.
    const texts = JSON.stringify(transcript?.entries)
    expect(texts).not.toContain('THIS BRANCH WAS ABANDONED')
    expect(transcript?.entries.map((e) => e.kind)).toEqual([
      'user',
      'assistant',
      'tool-result',
      'assistant',
    ])
  })

  it('reads the header, the session name, and the model', async () => {
    const transcript = await readPiTranscript(FIXTURE)
    expect(transcript?.sessionId).toBe('01a0323b-e39b-7ef4-8952-ea2ed705a55f')
    expect(transcript?.cwd).toBe('D:\\Projects\\Ari')
    // `session_info` outranks the first user message as a title.
    expect(transcript?.title).toBe('Package tour')
    expect(transcript?.model).toBe('claude-sonnet-4-5')
  })

  it('carries thinking, tool calls, results, and usage across', async () => {
    const transcript = await readPiTranscript(FIXTURE)
    const first = transcript?.entries[1]
    expect(first).toMatchObject({
      kind: 'assistant',
      blocks: [{ type: 'thinking', text: 'I should list the workspace first.' }],
      usage: { inputTokens: 6881, outputTokens: 111, costUsd: 0.0145432 },
    })
    expect(first).toHaveProperty('toolCalls', [
      { callId: 'call-1', name: 'bash', argsJson: '{"command":"ls packages"}' },
    ])
    expect(transcript?.entries[2]).toMatchObject({
      kind: 'tool-result',
      callId: 'call-1',
      name: 'bash',
      isError: false,
    })
  })

  it('falls back to the first user message when the session is unnamed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-pi-sess-'))
    const path = join(dir, 'x.jsonl')
    await writeFile(
      path,
      [
        '{"type":"session","version":3,"id":"s1","timestamp":"2026-08-01T00:00:00.000Z","cwd":"/w"}',
        '{"type":"message","id":"a","parentId":null,"message":{"role":"user","content":[{"type":"text","text":"fix the flaky test"}],"timestamp":1}}',
      ].join('\n'),
      'utf8',
    )
    expect((await readPiTranscript(path))?.title).toBe('fix the flaky test')
  })

  it('maps a user-run bash execution to a call plus its result', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-pi-sess-'))
    const path = join(dir, 'bash.jsonl')
    await writeFile(
      path,
      [
        '{"type":"session","version":3,"id":"s2","timestamp":"2026-08-01T00:00:00.000Z","cwd":"/w"}',
        '{"type":"message","id":"a","parentId":null,"message":{"role":"bashExecution","command":"pnpm test","output":"1 failed","exitCode":1,"cancelled":false,"timestamp":5}}',
      ].join('\n'),
      'utf8',
    )
    const entries = (await readPiTranscript(path))?.entries ?? []
    expect(entries.map((e) => e.kind)).toEqual(['assistant', 'tool-result'])
    expect(entries[1]).toMatchObject({ isError: true, name: 'bash' })
  })

  it('survives a truncated final line and answers null for a non-session file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-pi-sess-'))
    const truncated = join(dir, 'partial.jsonl')
    await writeFile(
      truncated,
      [
        '{"type":"session","version":3,"id":"s3","timestamp":"2026-08-01T00:00:00.000Z","cwd":"/w"}',
        '{"type":"message","id":"a","parentId":null,"message":{"role":"user","content":"hi","timestamp":1}}',
        '{"type":"message","id":"b","parentId":"a","message":{"role":"assis',
      ].join('\n'),
      'utf8',
    )
    expect((await readPiTranscript(truncated))?.entries).toHaveLength(1)

    const notSession = join(dir, 'other.jsonl')
    await writeFile(notSession, '{"hello":"world"}\n', 'utf8')
    expect(await readPiTranscript(notSession)).toBeNull()
    expect(await readPiTranscript(join(dir, 'missing.jsonl'))).toBeNull()
  })
})

describe('listPiSessions', () => {
  it('lists sessions newest first and filters by working directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-pi-root-'))
    const env: DetectEnvironment = { ...ENV, vars: { PI_CODING_AGENT_SESSION_DIR: root } }

    await writeSession(root, '--D--Projects-Ari--', 'one.jsonl', 'D:\\Projects\\Ari', 'first')
    await writeSession(root, '--D--Projects-Other--', 'two.jsonl', 'D:\\Projects\\Other', 'second')

    const all = await listPiSessions({}, env)
    expect(all).toHaveLength(2)

    const scoped = await listPiSessions({ cwd: 'D:\\Projects\\Ari' }, env)
    expect(scoped.map((s) => s.title)).toEqual(['first'])
    expect(scoped[0]?.cwd).toBe('D:\\Projects\\Ari')
    expect(scoped[0]?.messageCount).toBe(1)
  })

  it('treats Pi folder encoding as a hint rather than a filter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-pi-root-'))
    const env: DetectEnvironment = { ...ENV, vars: { PI_CODING_AGENT_SESSION_DIR: root } }
    await writeSession(root, '--future-encoding--', 'one.jsonl', '/workspace', 'still found')

    expect((await listPiSessions({ cwd: '/workspace' }, env)).map((s) => s.title)).toEqual([
      'still found',
    ])
  })

  it('skips a corrupt file instead of hiding the rest of the history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-pi-root-'))
    const env: DetectEnvironment = { ...ENV, vars: { PI_CODING_AGENT_SESSION_DIR: root } }
    await writeSession(root, '--w--', 'good.jsonl', '/w', 'kept')
    await writeFile(join(root, '--w--', 'bad.jsonl'), 'not json at all\n', 'utf8')
    expect((await listPiSessions({}, env)).map((s) => s.title)).toEqual(['kept'])
  })

  it('answers empty when pi has never written a session dir', async () => {
    expect(
      await listPiSessions({}, { ...ENV, vars: { PI_CODING_AGENT_SESSION_DIR: '/nope' } }),
    ).toEqual([])
  })
})

async function writeSession(
  root: string,
  folder: string,
  file: string,
  cwd: string,
  prompt: string,
): Promise<void> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(root, folder), { recursive: true })
  await writeFile(
    join(root, folder, file),
    [
      `{"type":"session","version":3,"id":"${file}","timestamp":"2026-08-01T00:00:00.000Z","cwd":${JSON.stringify(cwd)}}`,
      `{"type":"message","id":"a","parentId":null,"message":{"role":"user","content":[{"type":"text","text":${JSON.stringify(prompt)}}],"timestamp":1}}`,
    ].join('\n'),
    'utf8',
  )
}
