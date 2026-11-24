import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { createReadStream } from 'node:fs'

// Read-only profile inspection. Never emits prompts, responses, credentials, or titles.
const root = process.argv[2]
if (!root)
  throw new Error('Usage: node scripts/first-token-audit.mjs <sessions-directory> [output.json]')
const entries = await readdir(root, { withFileTypes: true })
const candidates = []
for (const entry of entries) {
  if (!entry.isDirectory()) continue
  try {
    const index = JSON.parse(await readFile(join(root, entry.name, 'index.json'), 'utf8'))
    candidates.push({ id: entry.name, updatedAt: index.updatedAt })
  } catch {
    /* Empty or incomplete sessions do not contain useful measurements. */
  }
}
candidates.sort((a, b) => b.updatedAt - a.updatedAt)
const rows = []
let rejectedLines = 0
for (const candidate of candidates.slice(0, 200)) {
  const dir = join(root, candidate.id)
  const files = (await readdir(dir)).filter((name) => /^journal\.\d+\.jsonl$/.test(name)).sort()
  let session = null
  let turn = null
  let number = 0
  const queuedTimes = []
  let dequeuedAt = null
  const finish = () => {
    if (!turn) return
    const elapsed = (at) => (at == null ? null : (at - turn.at) / 1000)
    rows.push({
      sessionId: candidate.id,
      turnNumber: number,
      at: turn.at,
      driverKind: turn.session?.driverKind,
      modelId: turn.session?.modelId,
      effort: turn.session?.effort ?? null,
      helm: turn.session?.projectId === 'helm',
      queueSeconds: turn.queueAt == null ? null : (turn.at - turn.queueAt) / 1000,
      checkpointSeconds: elapsed(turn.checkpointAt),
      providerRefSeconds: elapsed(turn.refAt),
      firstActivitySeconds: elapsed(turn.activityAt),
      firstThinkingSeconds: elapsed(turn.thinkingAt),
      firstTextSeconds: elapsed(turn.textAt),
      firstToolSeconds: elapsed(turn.toolAt),
      status: turn.status ?? 'unfinished',
    })
  }
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(join(dir, file)), crlfDelay: Infinity })
    for await (const line of lines) {
      let event
      try {
        event = JSON.parse(line)
      } catch {
        rejectedLines++
        continue
      }
      if (event.type === 'session.created') session = event.session
      if (
        (event.type === 'session.provider.switched' || event.type === 'session.updated') &&
        session
      ) {
        for (const key of ['driverKind', 'modelId', 'effort']) {
          if (Object.hasOwn(event, key)) session = { ...session, [key]: event[key] }
        }
      }
      if (event.type === 'message.enqueued') queuedTimes.push(event.at)
      if (event.type === 'message.dequeued') dequeuedAt = queuedTimes.shift() ?? null
      if (event.type === 'turn.started') {
        finish()
        number++
        turn = { at: event.at, queueAt: dequeuedAt, session }
        dequeuedAt = null
      }
      if (!turn) continue
      if (event.type === 'checkpoint.captured' && turn.checkpointAt == null)
        turn.checkpointAt = event.at
      if (event.type === 'session.ref.observed') turn.refAt ??= event.at
      if (event.type === 'turn.settled') {
        turn.status = event.stopReason
        finish()
        turn = null
        continue
      }
      if (event.type === 'assistant.parts.appended') {
        for (const part of event.parts ?? []) {
          if (['text', 'thinking', 'tool-call'].includes(part.type)) turn.activityAt ??= event.at
          if (part.type === 'text' && part.text?.length) turn.textAt ??= event.at
          if (part.type === 'thinking' && part.text?.length) turn.thinkingAt ??= event.at
          if (part.type === 'tool-call') turn.toolAt ??= event.at
        }
      }
    }
  }
  finish()
}
const stats = (values) => {
  const sorted = values.filter((value) => value != null).sort((a, b) => a - b)
  const percentile = (p) => (sorted.length ? sorted[Math.ceil(sorted.length * p) - 1] : null)
  return {
    n: sorted.length,
    p50: percentile(0.5),
    p90: percentile(0.9),
    max: sorted.at(-1) ?? null,
  }
}
const groups = []
for (const driverKind of [...new Set(rows.map((row) => row.driverKind))]) {
  for (const first of [true, false]) {
    const selected = rows.filter(
      (row) =>
        row.driverKind === driverKind &&
        (row.turnNumber === 1) === first &&
        row.status === 'completed',
    )
    groups.push({
      driverKind,
      firstTurn: first,
      turns: selected.length,
      checkpoint: stats(selected.map((row) => row.checkpointSeconds)),
      providerRef: stats(selected.map((row) => row.providerRefSeconds)),
      firstActivity: stats(selected.map((row) => row.firstActivitySeconds)),
      firstText: stats(selected.map((row) => row.firstTextSeconds)),
    })
  }
}
const output = { scannedSessions: Math.min(candidates.length, 200), rejectedLines, groups, rows }
if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(output, null, 2) + '\n')
console.log(
  JSON.stringify({ scannedSessions: output.scannedSessions, rejectedLines, groups }, null, 2),
)
console.log('Recent first-turn stage timings (seconds):')
console.log(JSON.stringify(rows.filter((row) => row.turnNumber === 1).slice(0, 30), null, 2))
