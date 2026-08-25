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

/** Roll modelBreakdowns across days into a cost-ranked list. */
export function modelShares(report: CcusageReport): ModelShare[] {
  const byModel = new Map<string, { cost: number; tokens: number }>()
  for (const day of report.daily) {
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
