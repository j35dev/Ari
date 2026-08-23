/* Live smoke: detection + update awareness + dynamic catalog. Run via npx tsx. */
import { detectAll } from '../packages/providers/src/detector'
import { realDetectEnvironment } from '../packages/providers/src/types'
import { createUpdateChecker, NPM_PACKAGES } from '../packages/providers/src/updates'
import { CatalogService } from '../packages/providers/src/catalog-service'
import { catalogSource, modelsFor, setDynamicModels } from '../packages/providers/src/catalogs'

const env = realDetectEnvironment()
const detections = await detectAll(['claude', 'codex', 'opencode', 'grok', 'pi', 'hermes'], env)
console.log('=== DETECTION ===')
for (const d of detections) {
  console.log(` ${d.kind}: bin=${d.binaryPath ? 'yes' : 'no'} ver=${d.version ?? '-'} auth=${d.authStatus}`)
}

console.log('=== UPDATE CHECK ===')
const checker = createUpdateChecker({ timeoutMs: 8000 })
const enriched = await checker.enrich(detections)
for (const d of enriched) {
  if (!NPM_PACKAGES[d.kind]) continue
  console.log(` ${d.kind}: installed=${d.version} latest=${d.latestVersion} update=${d.updateAvailable}`)
}

console.log('=== CATALOG (snapshot fallback) ===')
for (const kind of ['claude', 'codex', 'grok'] as const) {
  const models = modelsFor(kind)
  console.log(` ${kind} (${catalogSource(kind)}): ${models.length} model(s), first: ${models[0]?.label}`)
}

console.log('=== CATALOG (live models.dev refresh) ===')
const service = new CatalogService({ ttlMs: 1 })
await service.refresh()
for (const kind of ['claude', 'codex', 'grok'] as const) {
  const models = modelsFor(kind)
  console.log(` ${kind} (${catalogSource(kind)}): ${models.length} model(s), first 3:`)
  for (const m of models.slice(0, 3)) console.log(`   - ${m.label} [${m.id}] ${m.contextHint ?? ''}`)
}

console.log('=== ACP PROBE (installed native kinds only) ===')
const { resolveAcpLaunch } = await import('../packages/providers/src/acp/launches')
const { AcpConnection } = await import('../packages/providers/src/acp/connection')
for (const kind of ['opencode', 'hermes'] as const) {
  const detection = detections.find((d) => d.kind === kind)
  if (!detection?.binaryPath) continue
  const launch = resolveAcpLaunch(kind, { cliBinaryPath: detection.binaryPath })
  if (!launch) continue
  try {
    const conn = await AcpConnection.connect({
      launch,
      cwd: process.cwd(),
      initializeTimeoutMs: 20000,
    })
    console.log(` ${kind}: initialized via ${launch.command} ${launch.args.join(' ')}`)
    console.log(`   agentInfo=${JSON.stringify(conn.initialize.agentInfo)}`)
    try {
      const created = await conn.newSession(process.cwd())
      const opts = created.configOptions ?? []
      console.log(`   session=${created.sessionId} configOptions=${opts.length}`)
      const modelOpt = opts.find((o) => o.category === 'model')
      if (modelOpt?.options) {
        console.log(
          `   MODELS FROM PROVIDER (${modelOpt.options.length}): ${modelOpt.options.slice(0, 8).map((o) => o.value).join(', ')}...`,
        )
        setDynamicModels(kind, 'live', modelOpt.options.map((o) => ({ id: String(o.value), label: o.name ?? String(o.value) })))
        console.log(`   merged into picker: ${modelsFor(kind).length} entries`)
      }
    } finally {
      conn.kill()
    }
  } catch (error) {
    console.log(` ${kind}: probe failed — ${error instanceof Error ? error.message : String(error)}`)
  }
}
