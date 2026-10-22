/* global setTimeout */
// Seed data and the fake model endpoint. Seeding goes through the target
// worktree's own stores (bundled on the fly) so the on-disk format always
// matches the build being measured.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export const ENDPOINT_ID = 'perf'
export const MODEL_ID = `ep:${ENDPOINT_ID}:perf-model`
export const markerHref = (key) => `https://perf.invalid/end/${key}`

const TOPICS = ['session store', 'transcript', 'composer', 'sidebar', 'IPC bridge', 'journal']
const WORDS =
  'the renderer keeps a projection of every journal event and folds deltas into messages so a reload replays the same state without asking the provider again while the main process owns the files'.split(
    ' ',
  )
const words = (seed, n) =>
  Array.from({ length: n }, (_, k) => WORDS[(seed * 7 + k * 3) % WORDS.length]).join(' ')
const para = (i) => `${words(i, 28)}. The \`${TOPICS[i % 6]}\` path ${words(i + 1, 16)}.`

function code(i, indent = '') {
  const lang = ['ts', 'py', 'bash', 'json'][i % 4]
  const body = {
    ts: (k) =>
      `export function step${i}_${k}(input: string[]): number {\n  return input.filter((s) => s.length > ${k}).length\n}`,
    py: (k) => `def step_${i}_${k}(items):\n    return [x for x in items if len(x) > ${k}]`,
    bash: (k) => `pnpm --filter @ari/desktop test -- --run step${i}_${k} | tee out-${k}.log`,
    json: (k) => `{ "step": ${i}, "k": ${k}, "files": ["src/a${k}.ts", "src/b${k}.ts"] }`,
  }[lang]
  const lines = Array.from({ length: 2 + (i % 5) }, (_, k) => body(k))
    .join('\n')
    .split('\n')
  return [`\`\`\`${lang}`, ...lines, '```'].map((l) => indent + l).join('\n')
}

/** Deterministic assistant reply: prose, lists, tables and fenced code (also inside lists). */
export function assistantMarkdown(i) {
  const out = [`### ${i}. Working on the ${TOPICS[i % 6]}`, para(i)]
  if (i % 2 === 0)
    out.push(
      `- ${words(i, 9)}\n- ${words(i + 2, 11)}\n  - ${words(i + 3, 7)}\n- **${words(i + 4, 4)}**`,
    )
  if (i % 3 === 0) out.push(code(i))
  if (i % 4 === 1)
    out.push(
      `1. ${words(i, 8)}:\n\n${code(i + 1, '   ')}\n\n2. ${words(i + 5, 10)}\n3. Run \`pnpm verify\``,
    )
  if (i % 5 === 2)
    out.push(
      `| file | lines | status |\n| --- | ---: | --- |\n${[1, 2, 3, 4].map((k) => `| src/${TOPICS[(i + k) % 6].replace(' ', '-')}.ts | ${i * k} | ok |`).join('\n')}`,
    )
  out.push(para(i + 7))
  return out.join('\n\n')
}

/** Real journals carry many small text parts (one per streamed delta). */
const chunked = (text) =>
  (text.match(/[\s\S]{1,24}/g) ?? []).map((t) => ({ type: 'text', text: t }))

function toolPair(i) {
  const callId = `call_${i}`
  const [name, args, result] = [
    [
      'Read',
      { file_path: `src/${TOPICS[i % 6]}.ts` },
      `${i}\texport const value = ${i}\n`.repeat(20),
    ],
    ['Bash', { command: `pnpm test -- step${i}` }, `✓ step${i} (${i} ms)\n`.repeat(12)],
    [
      'Edit',
      {
        file_path: `src/s${i}.ts`,
        old_string: `const a = ${i}\nconst b = 1`,
        new_string: `const a = ${i + 1}\nconst b = 2`,
      },
      'ok',
    ],
    ['Grep', { pattern: `step${i}`, path: 'src' }, `src/a.ts:${i}: step${i}\n`.repeat(6)],
  ][i % 4]
  return [
    { type: 'tool-call', callId, name, argsJson: JSON.stringify(args) },
    { type: 'tool-result', callId, resultJson: JSON.stringify(result), isError: false },
  ]
}

/** Bundles the target worktree's stores into one ESM file and imports it. */
export async function loadStores(appDir, scratchDir) {
  const desktop = join(appDir, 'apps', 'desktop')
  const vite = createRequire(join(desktop, 'package.json')).resolve('vite')
  const esbuild = createRequire(vite)('esbuild')
  const outfile = join(scratchDir, 'stores.bundle.mjs')
  await esbuild.build({
    stdin: {
      contents: `export { SessionStore } from '@ari/engine/session-store'
export { Journal } from '@ari/engine/journal'
export { ProjectStore } from '@ari/engine/projects'
export { SettingsStore } from '@ari/engine/settings'
export { EndpointStore } from '@ari/ari-core/endpoints'`,
      resolveDir: desktop,
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'error',
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  })
  return import(pathToFileURL(outfile).href)
}

/** Writes one session's journal in a single batch; the store derives its index later. */
async function seedSession(Journal, root, { id, projectId, title, turns, at, key }) {
  const journal = new Journal({ dir: join(root, id), name: 'journal', fsync: 'batch' })
  await journal.open()
  let seq = 0
  const append = (event) => journal.append({ ...event, seq: seq++, at: (at += 50), sessionId: id })
  await append({
    type: 'session.created',
    session: {
      id,
      projectId,
      title,
      driverKind: 'ari-core',
      modelId: MODEL_ID,
      permissionMode: 'ask',
      status: 'idle',
      createdAt: at,
      updatedAt: at,
    },
  })
  for (let i = 0; i < turns; i++) {
    const turnId = `turn_${id}_${i}`
    const messageId = `msg_${id}_${i}`
    await append({ type: 'turn.started', turnId })
    await append({
      type: 'user.message.added',
      message: {
        id: `${messageId}_u`,
        sessionId: id,
        turnId,
        role: 'user',
        parts: [{ type: 'text', text: `${words(i, 6 + (i % 20))}?` }],
        createdAt: at,
      },
    })
    await append({ type: 'session.status.changed', from: 'idle', to: 'running', reason: null })
    const last =
      i === turns - 1
        ? `

Done — [end of ${key}](${markerHref(key)})`
        : ''
    const parts = [...(i % 2 === 1 ? toolPair(i) : []), ...chunked(assistantMarkdown(i) + last)]
    for (let p = 0; p < parts.length; p += 20) {
      await append({ type: 'assistant.parts.appended', messageId, parts: parts.slice(p, p + 20) })
    }
    await append({
      type: 'usage.recorded',
      inputTokens: 1200 + i,
      outputTokens: 400,
      costUsd: null,
    })
    await append({ type: 'session.status.changed', from: 'running', to: 'idle', reason: null })
    await append({ type: 'turn.settled', turnId, stopReason: 'completed', errorMessage: null })
  }
  await journal.flush()
  await journal.close()
}

/**
 * Writes settings, a project, the fake endpoint and every session the
 * scenarios need into a fresh profile. Returns the session ids by key.
 */
export async function seedProfile({
  stores,
  profileDir,
  workspaceDir,
  endpointUrl,
  runs,
  longTurns,
  appearance,
  window,
}) {
  const settings = new stores.SettingsStore({ dir: profileDir })
  await settings.load()
  const off = { enabled: false }
  await settings.update({
    appearance,
    window,
    notifications: { settleSound: false, desktop: false, discordPresence: false },
    providers: { claude: off, codex: off, opencode: off, grok: off, pi: off, hermes: off },
  })
  const projects = new stores.ProjectStore({ dir: profileDir })
  await projects.load()
  const project = await projects.open(workspaceDir, 'perf-workspace')
  const endpoints = new stores.EndpointStore({ dir: join(profileDir, 'ari-core') })
  await endpoints.upsert({
    id: ENDPOINT_ID,
    name: 'Perf fake',
    baseUrl: endpointUrl,
    flavor: 'openai-chat',
    model: 'perf-model',
    models: [{ id: 'perf-model', label: 'perf-model', contextWindow: 200000, source: 'manual' }],
    headers: {},
    apiKey: null,
  })
  const root = join(profileDir, 'sessions')
  const now = Date.now()
  // One journal per shape is generated; the rest are clones with their ids
  // rewritten. The store then replays each once to write its index sidecar.
  const shapes = [
    { prefix: 'fill', count: 30, turns: 4, at: now - 172_800_000 },
    { prefix: 'long', count: runs * 2, turns: longTurns, at: now - 3_600_000 },
    { prefix: 'strm', count: runs * 2, turns: 40, at: now - 7_200_000 },
    { prefix: 'short', count: 1, turns: 3, at: now - 60_000 },
  ]
  const ids = {}
  const idOf = (key) => `sess_perf_${key.replace(/-/g, '_')}`
  await Promise.all(
    shapes.map(async ({ prefix, count, turns, at }) => {
      const keys = Array.from({ length: count }, (_, k) =>
        count === 1 ? prefix : `${prefix}-${String(k).padStart(2, '0')}`,
      )
      for (const key of keys)
        ids[key] = { id: idOf(key), title: `Perf ${key}`, href: markerHref(key) }
      await seedSession(stores.Journal, root, {
        key: keys[0],
        id: idOf(keys[0]),
        projectId: project.id,
        title: `Perf ${keys[0]}`,
        turns,
        at,
      })
      const files = await readdir(join(root, idOf(keys[0])))
      for (const key of keys.slice(1)) {
        await mkdir(join(root, idOf(key)))
        for (const file of files) {
          const text = await readFile(join(root, idOf(keys[0]), file), 'utf8')
          await writeFile(
            join(root, idOf(key), file),
            text.replaceAll(keys[0], key).replaceAll(idOf(keys[0]), idOf(key)),
          )
        }
      }
    }),
  )
  const store = new stores.SessionStore({ rootDir: root })
  const listed = await store.listSessions()
  for (const { id } of Object.values(ids)) {
    await store.load(id)
    const { rejectedCount, firstReason } = store.replayDiagnostics(id)
    await store.closeJournal(id)
    if (rejectedCount > 0)
      throw new Error(`seeded ${id} has ${rejectedCount} rejected lines: ${firstReason}`)
  }
  if (listed.length !== Object.keys(ids).length)
    throw new Error(`store lists ${listed.length} of ${Object.keys(ids).length} seeded sessions`)
  return { ids, projectId: project.id }
}

/**
 * OpenAI-compatible chat endpoint that streams realistic markdown at a fixed
 * token rate. `onStream` hears start/end so the harness can bracket sampling.
 */
export function startFakeModel({ tokensPerSecond, seconds, onStream }) {
  let source = ''
  for (let i = 1000; source.length < tokensPerSecond * seconds * 8; i++)
    source += assistantMarkdown(i) + '\n\n'
  const tokens = (source.match(/\s*\S+/g) ?? []).slice(0, tokensPerSecond * seconds)
  const chunk = (delta, extra = {}) =>
    `data: ${JSON.stringify({ choices: [{ index: 0, delta }], ...extra })}\n\n`
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ data: [{ id: 'perf-model', object: 'model' }] }))
    }
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      const streaming = (() => {
        try {
          return JSON.parse(body).stream === true
        } catch {
          return false
        }
      })()
      if (!streaming) {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(
          JSON.stringify({
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'Perf title' },
                finish_reason: 'stop',
              },
            ],
          }),
        )
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      const startedAt = Date.now()
      let sent = 0
      onStream?.('start')
      const tick = () => {
        if (res.destroyed) return onStream?.('end', sent)
        const due = Math.min(
          tokens.length,
          Math.floor(((Date.now() - startedAt) / 1000) * tokensPerSecond) + 1,
        )
        let out = ''
        while (sent < due) out += chunk({ content: tokens[sent++] })
        if (out) res.write(out)
        if (sent < tokens.length) return void setTimeout(tick, 10)
        res.end(
          chunk({}, { usage: { prompt_tokens: 1000, completion_tokens: sent } }) +
            'data: [DONE]\n\n',
        )
        onStream?.('end', sent)
      }
      tick()
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}/v1`, close: () => server.close() }),
    ),
  )
}
