// @vitest-environment node
import { expect, it } from 'vitest'
import { detectDriver } from '@ari/providers/detector'
import { fetchAllowance } from './provider-allowance'

it.skipIf(process.env['ARI_LIVE_ALLOWANCE'] !== '1')(
  'reads installed account allowances without a model turn',
  async () => {
    for (const kind of ['codex', 'grok', 'claude', 'pi'] as const) {
      const detection = await detectDriver(kind)
      if (!detection.binaryPath) continue
      const windows = await fetchAllowance(kind, detection.binaryPath)
      process.stdout.write(`${kind}: ${JSON.stringify(windows)}\n`)
      expect(Array.isArray(windows)).toBe(true)
      if (kind !== 'claude' && kind !== 'pi') expect(windows.length).toBeGreaterThan(0)
    }
  },
  90_000,
)
