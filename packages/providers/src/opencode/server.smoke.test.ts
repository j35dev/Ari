import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { findBinaries } from '../detector'
import { runCaptured } from '../off-thread'
import { realDetectEnvironment } from '../types'
import { OpencodeServerPool } from './server'
import { classifyOpencodeVersion } from './version'
import type { OcEvent } from './wire'

/**
 * Opt-in live check against the installed OpenCode servers. Read-only: it
 * starts `opencode serve`, reads catalogs and commands, creates and inspects a
 * scratch session, and stops the server. It never sends a prompt.
 */
it.skipIf(process.env['ARI_OPENCODE_SMOKE'] !== '1')(
  'talks to every installed OpenCode server generation without prompting',
  async () => {
    const binaries = findBinaries('opencode', realDetectEnvironment())
    const seen = new Set<string>()
    const report: Record<string, unknown>[] = []
    for (const binary of binaries) {
      const probe = await runCaptured(binary, ['--version'], { timeoutMs: 20_000 })
      const version = classifyOpencodeVersion(probe?.stdout ?? null)
      if (version === null || seen.has(version.generation)) continue
      seen.add(version.generation)
      const pool = new OpencodeServerPool({ idleMs: 60_000 })
      const cwd = await mkdtemp(join(tmpdir(), 'ari-opencode-smoke-'))
      const events: OcEvent[] = []
      try {
        const server = await pool.acquire({
          binary,
          generation: version.generation,
          env: { ...process.env },
        })
        server.on((event) => events.push(event))
        const catalog = await server.wire.catalog(cwd)
        const commands = await server.wire.commands(cwd)
        const { id, rulesApplied } = await server.wire.createSession(cwd, 'ask')
        expect(await server.wire.sessionExists(id, cwd)).toBe(true)
        expect(await server.wire.sessionExists('ses_doesnotexist000000000000', cwd)).toBe(false)
        // OpenCode 2 previews answer 404 here; the driver reports that as a notice.
        const permissions = await server.wire
          .setPermissions(id, cwd, 'allow-edits')
          .then(() => 'updated')
          .catch((error: unknown) => String(error))
        if (server.wire.setEnvironment)
          await server.wire.setEnvironment(id, cwd, { ARI_SMOKE: '1' })
        await server.wire.interrupt(id, cwd)
        await new Promise((resolve) => setTimeout(resolve, 1500))
        report.push({
          binary,
          version,
          models: catalog.models.length,
          sample: catalog.models.slice(0, 2),
          defaultModelId: catalog.defaultModelId,
          commands: commands.slice(0, 3),
          session: id,
          permissions,
          rulesApplied,
          events: events.filter((event) => 'sessionID' in event && event.sessionID === id),
        })
        expect(events.some((event) => event.type === 'session' && event.sessionID === id)).toBe(
          true,
        )
        // Leave no scratch session in the user's history.
        await server.http.request(
          'DELETE',
          version.generation === 'v2' ? `/api/session/${id}` : `/session/${id}`,
          { directory: cwd },
        )
        pool.release(server)
      } finally {
        await pool.shutdownAll()
        await rm(cwd, { recursive: true, force: true })
      }
    }
    const out = process.env['ARI_OPENCODE_SMOKE_OUT']
    if (out) await writeFile(out, JSON.stringify(report, null, 1))
    expect(seen.size).toBeGreaterThan(0)
  },
  180_000,
)
