import type { DriverKind } from '@ari/contracts/common'
import { createLogger } from '@ari/shared/logger'
import type { Detection } from './types'

const log = createLogger('providers:updates')

/**
 * Update awareness for installed CLIs (PLAN §4.1): each npm-distributed kind
 * is checked against its package's `latest` dist-tag so the providers grid
 * can flag stale installs. Kinds distributed outside npm (grok installer,
 * hermes pip) are absent — their update channel is unknown by design.
 */
export const NPM_PACKAGES: Partial<Record<DriverKind, string>> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  opencode: 'opencode-ai',
  pi: '@earendil-works/pi-coding-agent',
}

/** Extracts the first bare semver-ish token from a `--version` output line. */
export function parseVersionToken(text: string | null | undefined): string | null {
  if (!text) return null
  const match = text.match(/v?(\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?)/)
  return match?.[1] ?? null
}

/** Three-way compare of dotted numeric versions; non-numeric suffixes break ties alphabetically. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const parse = (v: string): { nums: number[]; rest: string } => {
    const segments = v.split('-')
    const core = segments[0] ?? '0'
    const nums = core.split('.').map((n) => Number.parseInt(n, 10) || 0)
    return { nums, rest: segments.slice(1).join('-') }
  }
  const pa = parse(a)
  const pb = parse(b)
  const len = Math.max(pa.nums.length, pb.nums.length)
  for (let i = 0; i < len; i++) {
    const na = pa.nums[i] ?? 0
    const nb = pb.nums[i] ?? 0
    if (na !== nb) return na < nb ? -1 : 1
  }
  // A prerelease (1.2.3-rc.1) sorts before its release (1.2.3).
  if (pa.rest !== pb.rest) {
    if (pa.rest === '') return 1
    if (pb.rest === '') return -1
    return pa.rest < pb.rest ? -1 : 1
  }
  return 0
}

export interface FetchLike {
  (url: string, init?: { signal?: AbortSignal }): Promise<Response>
}

export interface UpdateChecker {
  /** Returns copies with latestVersion/updateAvailable filled where knowable. */
  enrich(detections: Detection[]): Promise<Detection[]>
}

export interface UpdateCheckerOptions {
  fetchImpl?: FetchLike
  /** Registry base, overridable for mirrors and tests. */
  registryUrl?: string
  /** How long a successful pkg→latest answer stays fresh. Default 1h. */
  ttlMs?: number
  timeoutMs?: number
}

/**
 * Creates the update checker used by the desktop shell. Registry lookups are
 * strictly fail-soft: any network or parse problem leaves a detection's
 * update fields untouched (null) instead of failing detection itself.
 */
export function createUpdateChecker(options: UpdateCheckerOptions = {}): UpdateChecker {
  const doFetch = options.fetchImpl ?? ((url, init) => fetch(url, init))
  const registry = options.registryUrl ?? process.env['ARI_NPM_REGISTRY'] ?? 'https://registry.npmjs.org'
  const ttlMs = options.ttlMs ?? 60 * 60 * 1000
  const timeoutMs = options.timeoutMs ?? 6000
  const cache = new Map<string, { at: number; version: string | null }>()

  async function latestVersion(pkg: string): Promise<string | null> {
    const hit = cache.get(pkg)
    if (hit && Date.now() - hit.at < ttlMs) return hit.version
    try {
      const response = await doFetch(`${registry}/${encodeURIComponent(pkg)}/latest`, {
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = (await response.json()) as { version?: unknown }
      const version = typeof body.version === 'string' ? body.version : null
      cache.set(pkg, { at: Date.now(), version })
      return version
    } catch (error) {
      log.debug('update check failed', { pkg, error: String(error) })
      // Negative-cache briefly so an offline boot does not re-storm per render.
      cache.set(pkg, { at: Date.now() - ttlMs + 5 * 60 * 1000, version: null })
      return null
    }
  }

  return {
    async enrich(detections) {
      return Promise.all(
        detections.map(async (detection): Promise<Detection> => {
          const pkg = NPM_PACKAGES[detection.kind]
          if (!pkg || !detection.binaryPath) return detection
          const installed = parseVersionToken(detection.version)
          const latest = await latestVersion(pkg)
          if (latest === null) {
            return { ...detection, latestVersion: null, updateAvailable: null }
          }
          const updateAvailable =
            installed !== null ? compareSemver(installed, latest) < 0 : null
          return { ...detection, latestVersion: latest, updateAvailable }
        }),
      )
    },
  }
}
