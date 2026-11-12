// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { checkoutChoices, groupRepositories, type ProjectCheckout } from './repository-groups'
const project = (hostId: string, projectId: string, canonicalKey: string | null, originKey?: string): ProjectCheckout => ({
  hostId, projectId, hostName: hostId, name: 'Ari', local: hostId === 'local', checkoutLabel: projectId,
  repository: canonicalKey ? { canonicalKey, originKey } : null,
})
describe('sidebar repository grouping', () => {
  it('merges local/remote clones and retains same-host checkouts for explicit choice', () => {
    const groups = groupRepositories([project('local', 'l', 'github.com/j35dev/ari'),
      project('remote', 'r1', 'github.com/j35dev/ari'), project('remote', 'r2', 'github.com/j35dev/ari')])
    expect(groups).toHaveLength(1)
    expect(checkoutChoices(groups[0]!, 'remote').map((p) => p.projectId)).toEqual(['r1', 'r2'])
  })
  it('keeps differing origins separate from upstream and never merges unknown/local remotes', () => {
    const groups = groupRepositories([project('local', 'l', 'github.com/j35dev/ari'),
      project('remote', 'fork', 'github.com/j35dev/ari', 'github.com/fork/ari'),
      project('local', 'none', null), project('remote', 'none', null)])
    expect(groups).toHaveLength(4)
    expect(groups[1]!.label).toBe('github.com/fork/ari')
  })
})
