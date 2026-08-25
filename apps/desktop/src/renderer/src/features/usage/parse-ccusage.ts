/** One calendar-day row from ccusage `--json`. Extra fields are ignored. */
export interface CcusageDay {
  date: string
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalTokens: number
  totalCost: number
  modelsUsed: string[]
  modelBreakdowns: { modelName: string; inputTokens: number; outputTokens: number; totalCost: number }[]
}

export interface CcusageTotals {
  inputTokens: number
  outputTokens: number
  cacheCreationTokens: number
  cacheReadTokens: number
  totalCost: number
  totalTokens: number
}

export interface CcusageReport {
  daily: CcusageDay[]
  totals: CcusageTotals
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function parseDay(raw: unknown): CcusageDay | null {
  if (raw === null || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  // ccusage v3 renamed `date` to `period`; accept both so upgrades never
  // silently empty the dashboard again.
  const date = str(row['date']) || str(row['period'])
  if (date.length === 0) return null
  const modelsUsed = Array.isArray(row['modelsUsed'])
    ? row['modelsUsed'].filter((m): m is string => typeof m === 'string')
    : []
  const modelBreakdowns = Array.isArray(row['modelBreakdowns'])
    ? row['modelBreakdowns'].flatMap((item) => {
        if (item === null || typeof item !== 'object') return []
        const m = item as Record<string, unknown>
        const modelName = str(m['modelName'])
        if (modelName.length === 0) return []
        return [
          {
            modelName,
            inputTokens: num(m['inputTokens']),
            outputTokens: num(m['outputTokens']),
            // v3 renamed breakdown `totalCost` to `cost`.
            totalCost: num(m['totalCost'] ?? m['cost']),
          },
        ]
      })
    : []
  return {
    date,
    inputTokens: num(row['inputTokens']),
    outputTokens: num(row['outputTokens']),
    cacheCreationTokens: num(row['cacheCreationTokens']),
    cacheReadTokens: num(row['cacheReadTokens']),
    totalTokens: num(row['totalTokens']),
    totalCost: num(row['totalCost']),
    modelsUsed,
    modelBreakdowns,
  }
}

/**
 * Pull a JSON object out of mixed ccusage stdout (npx banners + JSON).
 * Fail-soft: unparseable output returns null so the UI can show a message.
 */
export function parseCcusageJson(raw: string): CcusageReport | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const obj = parsed as Record<string, unknown>
  const dailyRaw = obj['daily']
  const daily = Array.isArray(dailyRaw) ? dailyRaw.flatMap((row) => {
    const day = parseDay(row)
    return day === null ? [] : [day]
  }) : []
  const totalsRaw = obj['totals']
  const totalsObj = totalsRaw !== null && typeof totalsRaw === 'object' ? (totalsRaw as Record<string, unknown>) : {}
  return {
    daily,
    totals: {
      inputTokens: num(totalsObj['inputTokens']),
      outputTokens: num(totalsObj['outputTokens']),
      cacheCreationTokens: num(totalsObj['cacheCreationTokens']),
      cacheReadTokens: num(totalsObj['cacheReadTokens']),
      totalCost: num(totalsObj['totalCost']),
      totalTokens: num(totalsObj['totalTokens']),
    },
  }
}

export interface ModelShare {
  modelName: string
  cost: number
  tokens: number
  share: number
}

/** Roll model breakdowns across days into a cost-ranked list. */
export function modelShares(days: CcusageDay[]): ModelShare[] {
  const byModel = new Map<string, { cost: number; tokens: number }>()
  for (const day of days) {
    for (const model of day.modelBreakdowns) {
      const prev = byModel.get(model.modelName) ?? { cost: 0, tokens: 0 }
      prev.cost += model.totalCost
      prev.tokens += model.inputTokens + model.outputTokens
      byModel.set(model.modelName, prev)
    }
  }
  const totalCost = [...byModel.values()].reduce((sum, row) => sum + row.cost, 0)
  return [...byModel.entries()]
    .map(([modelName, row]) => ({
      modelName,
      cost: row.cost,
      tokens: row.tokens,
      share: totalCost > 0 ? row.cost / totalCost : 0,
    }))
    .sort((a, b) => b.cost - a.cost)
}

export function formatUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(2)}`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`
  return String(Math.round(n))
}

export function formatRange(days: CcusageDay[]): string {
  if (days.length === 0) return ''
  const first = days[0]?.date
  const last = days[days.length - 1]?.date
  if (first === undefined || last === undefined) return ''
  return first === last ? first : `${first} to ${last}`
}

/** Report granularity for the usage window. */
export type Granularity = 'daily' | 'weekly' | 'monthly'

/**
 * Normalize a ccusage row date to `YYYY-MM-DD`. Older ccusage emitted
 * `YYYYMMDD`; current emits dashed ISO. Null when unparseable.
 */
export function normalizeDate(raw: string): string | null {
  const dashed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : /^\d{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : null
  if (dashed === null) return null
  return Number.isNaN(Date.parse(dashed)) ? null : dashed
}

/** ISO `YYYY-MM-DD` for a date, in local time. */
export function isoDate(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0')
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Days on/after `since` (`YYYY-MM-DD`); null since keeps everything. */
export function daysSince(days: CcusageDay[], since: string | null): CcusageDay[] {
  if (since === null) return days
  return days.filter((day) => {
    const date = normalizeDate(day.date)
    return date !== null && date >= since
  })
}

/** One aggregated bar in the usage chart. */
export interface DayBucket {
  key: string
  label: string
  days: CcusageDay[]
}

/** Monday of the week containing `date`, as `YYYY-MM-DD`. */
function weekStart(date: string): string {
  const d = new Date(`${date}T00:00:00`)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return isoDate(d)
}

/**
 * Roll daily rows up to the report granularity. Weekly buckets start on
 * Monday; monthly buckets are calendar months. Derived client-side from the
 * daily report so switching granularity never re-runs the ccusage process.
 */
export function bucketDays(days: CcusageDay[], granularity: Granularity): DayBucket[] {
  if (granularity === 'daily') {
    return days.map((day) => ({ key: day.date, label: normalizeDate(day.date) ?? day.date, days: [day] }))
  }
  const buckets = new Map<string, DayBucket>()
  for (const day of days) {
    const date = normalizeDate(day.date)
    if (date === null) continue
    const key = granularity === 'weekly' ? weekStart(date) : date.slice(0, 7)
    const bucket = buckets.get(key) ?? { key, label: key, days: [] }
    bucket.days.push(day)
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
}
