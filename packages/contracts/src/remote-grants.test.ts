import { describe, expect, it } from 'vitest'
import { rpcParams } from './rpc'

describe('desktop device grant decisions', () => {
  it('approves all-project access without selecting projects and defaults terminal access off', () => {
    expect(
      rpcParams['remote.approve'].parse({
        invitationId: 'inv_phone',
        confirmationCode: '7F3K-2Q9D',
      }),
    ).toEqual({
      invitationId: 'inv_phone',
      confirmationCode: '7F3K-2Q9D',
      projectIds: [],
      allowTerminal: false,
    })
  })

  it('edits terminal access without a project picker and requires an explicit terminal decision', () => {
    expect(
      rpcParams['remote.updateDeviceGrants'].parse({ deviceId: 'dev_phone', allowTerminal: false }),
    ).toEqual({ deviceId: 'dev_phone', projectIds: [], allowTerminal: false })
    expect(
      rpcParams['remote.updateDeviceGrants'].safeParse({ deviceId: 'dev_phone' }).success,
    ).toBe(false)
  })

  it('continues accepting legacy project snapshots', () => {
    expect(
      rpcParams['remote.approve'].parse({
        invitationId: 'inv_phone',
        confirmationCode: '7F3K-2Q9D',
        projectIds: ['existing'],
        allowTerminal: true,
      }).projectIds,
    ).toEqual(['existing'])
  })
})
