import type { DriverKind } from '@ari/contracts/common'
import type { Driver, Detection } from './driver'
import { detectDriver } from './detector'
import { realDetectEnvironment } from './types'
import type { DetectEnvironment } from './types'

/**
 * Owns driver instances by kind. Drivers are stateless factories; adapters
 * (live processes) are created per turn and NOT tracked here — the engine
 * owns adapter lifecycles.
 */
export class DriverRegistry {
  readonly #drivers = new Map<DriverKind, Driver>()

  register(driver: Driver): void {
    this.#drivers.set(driver.kind, driver)
  }

  get(kind: DriverKind): Driver | null {
    return this.#drivers.get(kind) ?? null
  }

  registeredKinds(): DriverKind[] {
    return [...this.#drivers.keys()]
  }

  /** Detects every registered driver kind exactly once. */
  async detectAll(env: DetectEnvironment = realDetectEnvironment()): Promise<Detection[]> {
    const kinds: DriverKind[] = [...new Set<DriverKind>([...this.#drivers.keys(), 'ari-core'])]
    return Promise.all(kinds.map((kind) => detectDriver(kind, env)))
  }
}
