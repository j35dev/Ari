import type { DriverKind } from '@ari/contracts/common'
import { codexAllowanceSchema, grokAllowanceSchema } from '@ari/contracts/rpc'
import type { ProviderAllowance } from '@ari/contracts/rpc'

type Windows = ProviderAllowance['windows']

function timestamp(value: string | undefined): number | null {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : null
}

function piTimestamp(value: unknown): number | null {
  if (typeof value === 'number') {
    const ms = value > 1e11 ? value : value * 1000
    return Number.isFinite(ms) ? ms : null
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function piPercent(value: unknown): number {
  const percent = Number(value)
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new Error(`Invalid pi quota percent: ${String(value)}`)
  }
  return percent
}

/** Normalize only quota windows; token counts never imply remaining allowance. */
export function parseAllowance(kind: DriverKind, value: unknown): Windows {
  if (kind === 'grok') {
    const { config } = grokAllowanceSchema.parse(value)
    if (!config) return []
    const used =
      config.creditUsagePercent ??
      (config.monthlyLimit && config.monthlyLimit.val > 0 && config.used
        ? Math.min(100, (100 * config.used.val) / config.monthlyLimit.val)
        : undefined)
    if (used === undefined) return []
    const period = config.currentPeriod?.type
    const label =
      period === 'USAGE_PERIOD_TYPE_WEEKLY'
        ? 'Weekly'
        : period === 'USAGE_PERIOD_TYPE_MONTHLY' || (!period && config.monthlyLimit)
          ? 'Monthly'
          : 'Allowance'
    return [
      {
        label,
        usedPercent: used,
        resetsAt: timestamp(config.currentPeriod?.end ?? config.billingPeriodEnd),
      },
    ]
  }
  if (kind === 'codex') {
    const { rateLimits } = codexAllowanceSchema.parse(value)
    return [rateLimits.primary, rateLimits.secondary].flatMap((window) => {
      if (!window || window.windowDurationMins === null) return []
      const minutes = window.windowDurationMins
      return [
        {
          label:
            minutes === 10080 ? 'Weekly' : minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`,
          usedPercent: window.usedPercent,
          resetsAt: window.resetsAt === null ? null : window.resetsAt * 1000,
        },
      ]
    })
  }
  if (kind === 'pi') return []
  if (kind !== 'claude' || typeof value !== 'string') return []
  // Claude's structured /usage formatter emits these exact Markdown labels.
  return value.split('\n').flatMap((line) => {
    const match =
      /^\*\*(5-hour limit|Weekly · all models)\*\* — \*\*(\d+(?:\.\d+)?)%\*\*(?: · Resets (.+))?\s*$/.exec(
        line,
      )
    if (!match || Number(match[2]) > 100) return []
    return [
      {
        label: match[1] === '5-hour limit' ? '5h' : 'Weekly',
        usedPercent: Number(match[2]),
        resetsAt: null,
        ...(match[3] ? { resetText: match[3] } : {}),
      },
    ]
  })
}

interface PiUsageWindow {
  utilization?: unknown
  resets_at?: unknown
}

/**
 * Anthropic OAuth usage through pi's stored credentials. Response shapes
 * mirror pi-quotas' Anthropic fetcher (MIT, latentminds-ai/pi-quotas);
 * per-model and overage-budget windows stay out of the pill.
 */
export function parsePiAnthropicUsage(data: unknown): Windows {
  if (!data || typeof data !== 'object') return []
  const record = data as Record<string, PiUsageWindow | undefined>
  const windows: Windows = []
  const fiveHour = record['five_hour']
  if (fiveHour && fiveHour.utilization != null) {
    windows.push({
      label: 'Anthropic 5h',
      usedPercent: piPercent(fiveHour.utilization),
      resetsAt: piTimestamp(fiveHour.resets_at),
    })
  }
  const sevenDay = record['seven_day']
  if (sevenDay && sevenDay.utilization != null) {
    windows.push({
      label: 'Anthropic 7d',
      usedPercent: piPercent(sevenDay.utilization),
      resetsAt: piTimestamp(sevenDay.resets_at),
    })
  }
  return windows
}

function piCodexWindow(
  rateLimit: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | null {
  for (const key of keys) {
    const candidate = rateLimit[key]
    if (candidate && typeof candidate === 'object') return candidate as Record<string, unknown>
  }
  return null
}

function piCodexPercent(window: Record<string, unknown>): number | null {
  const remaining = window['percent_left'] ?? window['remaining_percent']
  if (typeof remaining === 'number' || (typeof remaining === 'string' && remaining.length > 0)) {
    return piPercent(100 - Number(remaining))
  }
  if (window['used_percent'] == null) return null
  return piPercent(window['used_percent'])
}

function piCodexLabel(window: Record<string, unknown>, fallback: string): string {
  const seconds = Number(window['limit_window_seconds'])
  if (!Number.isFinite(seconds) || seconds <= 0) return `Codex ${fallback}`
  if (seconds % 86400 === 0) return `Codex ${seconds / 86400}d`
  if (seconds % 3600 === 0) return `Codex ${seconds / 3600}h`
  if (seconds % 60 === 0) return `Codex ${seconds / 60}m`
  return `Codex ${seconds}s`
}

function piCodexReset(window: Record<string, unknown>): number | null {
  if (window['reset_at'] != null) return piTimestamp(window['reset_at'])
  const ms = window['reset_time_ms']
  if (typeof ms === 'number' && Number.isFinite(ms)) return ms
  if (typeof ms === 'string' && ms.trim().length > 0) {
    const parsed = Number(ms)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Codex wham/usage response through pi's stored credentials. Shapes mirror
 * pi-quotas' Codex fetcher (MIT, latentminds-ai/pi-quotas); credit balances
 * and spend caps carry no used-percent quota window, so they are skipped.
 */
export function parsePiCodexUsage(data: unknown): Windows {
  if (!data || typeof data !== 'object') return []
  const root = data as Record<string, unknown>
  const rawLimit = root['rate_limit'] ?? root['rate_limits']
  if (!rawLimit || typeof rawLimit !== 'object') return []
  const rateLimit = rawLimit as Record<string, unknown>
  const pairs: { window: Record<string, unknown> | null; fallback: string }[] = [
    {
      window: piCodexWindow(rateLimit, ['primary_window', 'primary', 'five_hour_limit', 'five_hour']),
      fallback: '5h',
    },
    {
      window: piCodexWindow(rateLimit, ['secondary_window', 'secondary', 'weekly_limit', 'weekly']),
      fallback: '7d',
    },
  ]
  return pairs.flatMap(({ window, fallback }) => {
    if (!window) return []
    const usedPercent = piCodexPercent(window)
    if (usedPercent === null) return []
    return [{ label: piCodexLabel(window, fallback), usedPercent, resetsAt: piCodexReset(window) }]
  })
}
