/**
 * Model-snapshot generator: fetches the models.dev registry (the same open
 * dataset opencode/T3-style clients use for provider/model metadata) and
 * writes a trimmed snapshot used as the offline fallback catalog for CLI
 * model pickers.
 *
 * Usage:
 *   npx tsx scripts/update-model-snapshot.ts [--url https://models.dev/api.json]
 *
 * The generated file is committed; CI never fetches. Re-run whenever the
 * upstream catalog should be re-pinned.
 */

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

/** models.dev provider ids backing each Ari CLI kind's offline fallback. */
const SNAPSHOT_PROVIDERS = ['anthropic', 'openai', 'xai'] as const

const DEFAULT_URL = 'https://models.dev/api.json'

/** Hard cap per provider so renderer pickers stay scrollable. */
const MAX_MODELS_PER_PROVIDER = 60

/** Id fragments that are never coding-chat models. */
const EXCLUDED_ID = /embedding|whisper|tts|dall-e|image|video|audio|transcribe|moderation|search|codex-redirect/i

interface ModelsDevModel {
  id?: string
  name?: string
  release_date?: string
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context?: number }
}

interface ModelsDevProvider {
  models?: Record<string, ModelsDevModel>
}

interface SnapshotEntry {
  id: string
  label: string
  contextHint?: string
}

interface Snapshot {
  generatedAt: number
  sourceUrl: string
  providers: Record<string, SnapshotEntry[]>
}

function contextHint(context?: number): string | undefined {
  if (!context || context <= 0) return undefined
  if (context >= 1_000_000) return `${Math.round(context / 100_000) / 10}m`
  return `${Math.round(context / 1000)}k`
}

function toEntry(id: string, model: ModelsDevModel): SnapshotEntry | null {
  const outputs = model.modalities?.output
  // Keep text-out models; tolerate entries without modality data.
  if (outputs && !outputs.includes('text')) return null
  if (EXCLUDED_ID.test(id)) return null
  const entry: SnapshotEntry = {
    id,
    label: typeof model.name === 'string' && model.name.length > 0 ? model.name : id,
  }
  const hint = contextHint(model.limit?.context)
  if (hint !== undefined) entry.contextHint = hint
  return entry
}

function fail(message: string): never {
  console.error(`update-model-snapshot: ${message}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const urlFlag = process.argv.indexOf('--url')
  const url = urlFlag !== -1 ? (process.argv[urlFlag + 1] ?? fail('--url needs a value')) : DEFAULT_URL

  console.log(`fetching ${url}`)
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) fail(`HTTP ${response.status} while fetching ${url}`)
  const body = (await response.json()) as Record<string, ModelsDevProvider>

  const snapshot: Snapshot = {
    generatedAt: Date.now(),
    sourceUrl: url,
    providers: {},
  }
  for (const providerId of SNAPSHOT_PROVIDERS) {
    const provider = body[providerId]
    if (!provider?.models) fail(`provider "${providerId}" missing from source data`)
    const entries = Object.entries(provider.models)
      .map(([id, model]) => toEntry(model.id ?? id, { ...model, id: model.id ?? id }))
      .filter((e): e is SnapshotEntry => e !== null)
      .sort((a, b) => {
        const da = provider.models?.[a.id]?.release_date ?? ''
        const db = provider.models?.[b.id]?.release_date ?? ''
        if (da !== db) return da < db ? 1 : -1
        return a.id.localeCompare(b.id)
      })
      .slice(0, MAX_MODELS_PER_PROVIDER)
    if (entries.length === 0) fail(`provider "${providerId}" produced zero usable models`)
    snapshot.providers[providerId] = entries
    console.log(`  ${providerId}: ${entries.length} model(s)`)
  }

  const outPath = resolve('packages/providers/src/catalog-snapshot.json')
  await writeFile(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
  console.log(`wrote ${outPath}`)
}

await main().catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error))
})
