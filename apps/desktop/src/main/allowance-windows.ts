import type { DriverKind } from '@ari/contracts/common'
import { codexAllowanceSchema, grokAllowanceSchema } from '@ari/contracts/rpc'
import type { ProviderAllowance } from '@ari/contracts/rpc'

type Windows = ProviderAllowance['windows']

function timestamp(value: string | undefined): number | null {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : null
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
