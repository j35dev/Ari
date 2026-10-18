import type { ProviderAccountRow } from '@ari/contracts/rpc'

/** One line saying who an account is, or why that is not known. */
export function accountIdentityLine(account: ProviderAccountRow, signingIn: boolean): string {
  if (account.identity?.signedIn === true) {
    const who = account.identity.email ?? 'Signed in'
    const plan = account.identity.plan
    // Providers name plans in lower case (`max`, `plus`); a label reads better capitalised.
    return plan === null ? who : `${who} · ${plan.charAt(0).toUpperCase()}${plan.slice(1)}`
  }
  if (signingIn) return 'Finish signing in in the Terminal…'
  return account.identity === null ? 'Could not check the sign-in' : 'Not signed in'
}
