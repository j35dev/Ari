import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionStore } from '@ari/engine/session-store'
import { ProjectStore } from '@ari/engine/projects'
import { importPiSession, listImportableSessions } from './session-import'
import type { SessionImportDeps } from './session-import'

/**
 * Every case builds a real pi session file and a real Ari store on disk: the
 * value of the importer is entirely in whether the journal it writes folds back
 * into a transcript, which a mocked store could not show.
 */

const FIXTURE = join(
  __dirname,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'providers',
  'src',
  'pi',
  '__fixtures__',
  'session-tree.jsonl',
)

let deps: SessionImportDeps
let piRoot = ''
let projectPath = ''
const originalSessionDir = process.env['PI_CODING_AGENT_SESSION_DIR']

beforeEach(async () => {
  piRoot = await mkdtemp(join(tmpdir(), 'ari-import-pi-'))
  process.env['PI_CODING_AGENT_SESSION_DIR'] = piRoot

  const ariRoot = await mkdtemp(join(tmpdir(), 'ari-import-store-'))
  projectPath = await mkdtemp(join(tmpdir(), 'ari-import-proj-'))
  const projects = new ProjectStore({ dir: ariRoot })
  await projects.load()
  await projects.add(projectPath)
  deps = { sessions: new SessionStore({ rootDir: join(ariRoot, 'sessions') }), projects }
})

afterEach(() => {
  if (originalSessionDir === undefined) delete process.env['PI_CODING_AGENT_SESSION_DIR']
  else process.env['PI_CODING_AGENT_SESSION_DIR'] = originalSessionDir
})

/** Writes a pi session file whose recorded cwd is the registered project. */
async function seedPiSession(name: string, prompt: string, cwd = projectPath): Promise<string> {
  const { mkdir } = await import('node:fs/promises')
  const folder = join(piRoot, `--${cwd.replace(/[:/\\]/g, '-')}--`)
  await mkdir(folder, { recursive: true })
  const path = join(folder, `${name}.jsonl`)
  await writeFile(
    path,
    [
      `{"type":"session","version":3,"id":"pi-${name}","timestamp":"2026-08-01T10:00:00.000Z","cwd":${JSON.stringify(cwd)}}`,
      `{"type":"message","id":"u1","parentId":null,"timestamp":"2026-08-01T10:00:05.000Z","message":{"role":"user","content":[{"type":"text","text":${JSON.stringify(prompt)}}],"timestamp":1785000005000}}`,
      `{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-08-01T10:00:09.000Z","message":{"role":"assistant","content":[{"type":"thinking","thinking":"considering"},{"type":"text","text":"done"}],"model":"grok-4.5","usage":{"input":120,"output":8,"cost":{"total":0.002}},"stopReason":"stop","timestamp":1785000009000}}`,
    ].join('\n'),
    'utf8',
  )
  return path
}

describe('listImportableSessions', () => {
  it("lists pi's sessions and marks the ones Ari already has", async () => {
    const path = await seedPiSession('one', 'refactor the store')
    const before = await listImportableSessions(deps)
    expect(before).toHaveLength(1)
    expect(before[0]).toMatchObject({ kind: 'pi', title: 'refactor the store', imported: false })

    await importPiSession({ path }, deps)
    const after = await listImportableSessions(deps)
    expect(after[0]?.imported).toBe(true)
  })
})

describe('importPiSession', () => {
  it('replays the transcript into a journal that folds back correctly', async () => {
    const path = await seedPiSession('two', 'summarize the diff')
    const result = await importPiSession({ path }, deps)
    expect(result).toMatchObject({ ok: true })
    if (!result.ok) return

    const model = await deps.sessions.load(result.sessionId)
    expect(model.session).toMatchObject({
      driverKind: 'pi',
      title: 'summarize the diff',
      modelId: 'grok-4.5',
      status: 'idle',
    })
    // The pi session id rides along so the next turn resumes rather than
    // re-prompting cold off a wall of replayed text.
    expect(model.providerSessionId).toBe('pi-two')
    expect(model.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(model.messages[1]?.parts).toEqual([
      { type: 'thinking', text: 'considering' },
      { type: 'text', text: 'done' },
    ])
    expect(model.usage).toMatchObject({ inputTokens: 120, outputTokens: 8, costUsd: 0.002 })
    // No turn is left open, so the sidebar cannot show it as running.
    expect(model.activeTurnId).toBeNull()
  })

  it('dates the session when the work happened, not at import time', async () => {
    const path = await seedPiSession('three', 'old work')
    const result = await importPiSession({ path }, deps)
    if (!result.ok) throw new Error('expected the import to succeed')
    const model = await deps.sessions.load(result.sessionId)
    expect(model.session?.createdAt).toBe(Date.parse('2026-08-01T10:00:00.000Z'))
  })

  it('carries tool calls and their results across as paired parts', async () => {
    const result = await importPiSession({ path: FIXTURE, projectId: firstProjectId() }, deps)
    if (!result.ok) throw new Error('expected the import to succeed')
    const model = await deps.sessions.load(result.sessionId)
    const parts = model.messages.flatMap((m) => m.parts)
    const call = parts.find((p) => p.type === 'tool-call')
    const toolResult = parts.find((p) => p.type === 'tool-result')
    expect(call).toMatchObject({ name: 'bash', callId: 'call-1' })
    expect(toolResult).toMatchObject({ callId: 'call-1', isError: false })
    // The abandoned branch in that fixture must not appear.
    expect(JSON.stringify(parts)).not.toContain('ABANDONED')
  })

  it('refuses a second import of the same pi session', async () => {
    const path = await seedPiSession('four', 'once only')
    expect(await importPiSession({ path }, deps)).toMatchObject({ ok: true })
    const again = await importPiSession({ path }, deps)
    expect(again).toMatchObject({ ok: false })
    expect(again).toHaveProperty('error', expect.stringContaining('already in Ari'))
  })

  it('explains itself when no Ari project matches the session folder', async () => {
    const path = await seedPiSession('five', 'stranded', 'D:\\Nowhere')
    const result = await importPiSession({ path }, deps)
    expect(result).toMatchObject({ ok: false })
    expect(result).toHaveProperty('error', expect.stringContaining('open the folder first'))
  })

  it('refuses a file that is not a pi session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ari-import-junk-'))
    const path = join(dir, 'notes.jsonl')
    await writeFile(path, '{"hello":"world"}\n', 'utf8')
    expect(await importPiSession({ path }, deps)).toMatchObject({ ok: false })
  })
})

function firstProjectId(): string {
  const id = deps.projects.list()[0]?.id
  if (id === undefined) throw new Error('no project registered')
  return id
}
