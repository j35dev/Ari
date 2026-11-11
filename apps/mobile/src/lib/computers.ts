import type { ConnectionState } from './session'

export const COMPUTERS_KEY = 'ari.remote.computers.v1'
export const LEGACY_ORIGIN_KEY = 'ari.remote.origin'
const MAX_COMPUTERS = 24
const HANDOFF = 'computers'
export interface SavedComputer {
  origin: string
  name: string
  managedComputerId?: string
  lastConnectedAt: number | null
  status: ConnectionState
}

/** Public addresses and labels only. Credentials always remain in the origin's key store. */
export function computerAddress(address: string, tailnetOnly = true): URL {
  const url = new URL(address.trim())
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.username || url.password) throw new Error('Use a computer address without a username or password.')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    throw new Error('Use the HTTPS address shown in desktop Mobile access settings.')
  if (tailnetOnly && !loopback && !url.hostname.endsWith('.ts.net'))
    throw new Error('Use your computer’s Tailscale address ending in .ts.net.')
  if (url.pathname !== '/') throw new Error('Use the root address shown in desktop Mobile access settings.')
  return url
}

export function computerName(origin: string): string {
  const url = computerAddress(origin, false)
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return 'This computer'
  return url.hostname.split('.')[0] || url.hostname
}

export function saveComputer(
  computers: SavedComputer[], origin: string, name?: string, managedComputerId?: string,
): SavedComputer[] {
  const canonical = computerAddress(origin, false).origin
  const existing = computers.find((computer) => computer.origin === canonical)
  const computer: SavedComputer = {
    ...existing, origin: canonical,
    name: name?.trim().slice(0, 80) || existing?.name || computerName(canonical),
    lastConnectedAt: existing?.lastConnectedAt ?? null, status: existing?.status ?? 'unpaired',
    ...(managedComputerId === undefined ? {} : { managedComputerId }),
  }
  return [...computers.filter((item) => item.origin !== canonical), computer].slice(-MAX_COMPUTERS)
}

function parseComputers(value: unknown): SavedComputer[] {
  if (!Array.isArray(value)) return []
  let computers: SavedComputer[] = []
  for (const item of value.slice(0, MAX_COMPUTERS)) {
    if (typeof item !== 'object' || item === null || !('origin' in item) || typeof item.origin !== 'string') continue
    try {
      const name = 'name' in item && typeof item.name === 'string' ? item.name : undefined
      const managed = 'managedComputerId' in item && typeof item.managedComputerId === 'string' ? item.managedComputerId : undefined
      computers = saveComputer(computers, item.origin, name, managed)
      const added = computers.at(-1)
      if (added !== undefined && 'lastConnectedAt' in item && typeof item.lastConnectedAt === 'number' && Number.isFinite(item.lastConnectedAt))
        added.lastConnectedAt = item.lastConnectedAt
      // Persisted connectivity is history, never proof of a live authorization.
      if (added !== undefined && added.lastConnectedAt !== null) added.status = 'unreachable'
    } catch { /* Ignore malformed entries rather than losing the usable registry. */ }
  }
  return computers
}

export function readComputers(): SavedComputer[] {
  try {
    let computers = parseComputers(JSON.parse(localStorage.getItem(COMPUTERS_KEY) ?? '[]') as unknown)
    const legacy = localStorage.getItem(LEGACY_ORIGIN_KEY)
    if (legacy !== null && !computers.some((item) => item.origin === legacy)) computers = saveComputer(computers, legacy)
    return computers
  } catch { return [] }
}

export function writeComputers(computers: SavedComputer[]): void {
  try { localStorage.setItem(COMPUTERS_KEY, JSON.stringify(computers)) }
  catch (error) { console.warn('Could not remember the computer list', error) }
}

/** Transfer only the user-visible directory when navigating between private PWA origins. */
export function computerDestination(address: string, computers: SavedComputer[]): string {
  const url = computerAddress(address)
  const params = new URLSearchParams(url.hash.slice(1))
  const directory = computers.filter((item) => item.managedComputerId === undefined).map(({ origin, name }) => ({ origin, name }))
  params.set(HANDOFF, JSON.stringify(directory))
  url.search = ''
  url.hash = params.toString()
  return url.href
}

/** Consume public directory metadata without discarding a pairing invitation in the same fragment. */
export function takeComputerDirectory(href: string, computers: SavedComputer[]): SavedComputer[] {
  const url = new URL(href)
  const params = new URLSearchParams(url.hash.slice(1))
  const raw = params.get(HANDOFF)
  if (raw === null) return computers
  params.delete(HANDOFF)
  url.hash = params.toString()
  history.replaceState(null, '', url.href)
  if (raw.length > 16_000) return computers
  try {
    for (const entry of parseComputers(JSON.parse(raw) as unknown)) {
      // A link cannot inject a managed broker identifier or a non-tailnet destination.
      const destination = computerAddress(entry.origin)
      computers = saveComputer(computers, destination.origin, entry.name)
    }
  } catch { /* A broken directory link does not stop pairing with the current host. */ }
  return computers
}

/** Forget only this origin's local drafts, receipt identifiers and terminal references. */
export function forgetComputerState(origin: string): void {
  const prefixes = ['draft', 'pending', 'creation', 'fork', 'integration', 'terminal', 'new-draft']
  try {
    const remove: string[] = []
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index)
      if (key !== null && prefixes.some((prefix) => key.startsWith(`ari.${prefix}:${origin}:`))) remove.push(key)
    }
    remove.forEach((key) => sessionStorage.removeItem(key))
  } catch (error) { console.warn('Could not clear this computer’s local drafts', error) }
}
