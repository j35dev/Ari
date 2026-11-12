/** Resource samples are authenticated live metadata, never restored eligibility. */
export const RESOURCE_FRESH_MS = 30_000
export const MAX_CPU_UTILIZATION = 0.85
export const MIN_AVAILABLE_MEMORY_BYTES = 1.5 * 1024 ** 3
export const MIN_AVAILABLE_MEMORY_FRACTION = 0.1

export type MachinePreference = 'prefer' | 'normal' | 'less-often' | 'manual-only'
export interface SelectionHost {
  id: string
  name: string
  connected: boolean
  compatible: boolean
  hasProject: boolean
  usableCatalog: boolean
  preference: MachinePreference
  resources: {
    sampledAt: number
    available: boolean
    cpuUtilization: number | null
    availableMemoryBytes: number | null
    totalMemoryBytes: number | null
  } | null
}
export type AutoSelection =
  | { hostId: string; reason: string }
  | { hostId: null; reason: string }

export function manualEligibility(host: SelectionHost): string | null {
  if (!host.connected) return 'Offline — reconnect to select this machine.'
  if (!host.compatible) return 'Update Ari on this machine before starting a session.'
  if (!host.hasProject) return 'This repository has no checkout on this machine.'
  if (!host.usableCatalog) return 'No usable agent catalog on this machine.'
  return null
}

export function resourceEligibility(host: SelectionHost, now: number): string | null {
  const sample = host.resources
  if (
    !sample?.available ||
    sample.sampledAt > now ||
    now - sample.sampledAt > RESOURCE_FRESH_MS ||
    sample.cpuUtilization === null ||
    !Number.isFinite(sample.cpuUtilization) ||
    sample.cpuUtilization < 0 || sample.cpuUtilization > 1 ||
    sample.availableMemoryBytes === null ||
    !Number.isFinite(sample.availableMemoryBytes) ||
    sample.totalMemoryBytes === null ||
    !Number.isFinite(sample.totalMemoryBytes) ||
    sample.totalMemoryBytes <= 0 ||
    sample.availableMemoryBytes < 0 ||
    sample.availableMemoryBytes > sample.totalMemoryBytes
  ) return 'Fresh CPU and memory data required — select a machine manually.'
  if (
    sample.cpuUtilization >= MAX_CPU_UTILIZATION ||
    sample.availableMemoryBytes < MIN_AVAILABLE_MEMORY_BYTES ||
    sample.availableMemoryBytes / sample.totalMemoryBytes < MIN_AVAILABLE_MEMORY_FRACTION
  ) return 'Busy — select a machine manually to start here.'
  return null
}

/** Called only for an explicit Auto selection; refreshes never move a draft. */
export function selectAutoHost(hosts: readonly SelectionHost[], now = Date.now()): AutoSelection {
  const tier: Record<MachinePreference, number> = {
    prefer: 0, normal: 1, 'less-often': 2, 'manual-only': 3,
  }
  const eligible = hosts.filter((host) =>
    host.preference !== 'manual-only' && manualEligibility(host) === null &&
    resourceEligibility(host, now) === null,
  ).sort((a, b) =>
    tier[a.preference] - tier[b.preference] ||
    a.resources!.cpuUtilization! - b.resources!.cpuUtilization! ||
    b.resources!.availableMemoryBytes! - a.resources!.availableMemoryBytes! ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  const host = eligible[0]
  if (!host) return {
    hostId: null,
    reason: 'Auto needs an available machine with fresh CPU and memory data. Select a machine manually.',
  }
  const preference = host.preference === 'prefer' ? 'Preferred machine' :
    host.preference === 'less-often' ? 'Less often' : 'Normal preference'
  return {
    hostId: host.id,
    reason: `${host.name} · ${preference} · ${Math.round(host.resources!.cpuUtilization! * 100)}% CPU · ${(host.resources!.availableMemoryBytes! / 1024 ** 3).toFixed(1)} GB free`,
  }
}

/** Auto dispatch checks the original host; it never substitutes or queues. */
export function validateSelection(host: SelectionHost | undefined, auto: boolean, now = Date.now()): string | null {
  if (!host) return 'The selected machine is no longer available.'
  return manualEligibility(host) ?? (auto ? resourceEligibility(host, now) : null)
}
