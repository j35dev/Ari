import type { DriverKind } from '@ari/contracts/common'

let resolve: (kind: DriverKind) => Record<string, string> = () => ({})

/**
 * Installs the source of each provider's account variables. Until one is
 * installed every provider runs as its default account, which is also what
 * tests of the readers below get.
 */
export function setProviderEnvironment(source: (kind: DriverKind) => Record<string, string>): void {
  resolve = source
}

/**
 * The variables that make a provider's CLI run as the account in use (for
 * Claude, `CLAUDE_CONFIG_DIR`); empty for the default account. Every process
 * Ari starts for a provider has to carry these, or it would read one
 * account's usage and run turns as another.
 */
export function providerEnvironment(kind: DriverKind): Record<string, string> {
  return resolve(kind)
}
