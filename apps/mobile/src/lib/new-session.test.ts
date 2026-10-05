// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { readCreation, writeCreation } from './new-session'

beforeEach(() => sessionStorage.clear())

describe('an unconfirmed session creation', () => {
  it('comes back with the effort and permission mode it was sent with', () => {
    const request = {
      key: 'receipt-0001',
      projectId: 'proj_1',
      driverKind: 'codex',
      modelId: 'gpt',
      effort: 'high',
      permissionMode: 'full' as const,
      draft: 'Fix the build',
    }
    expect(writeCreation('https://phone.test', 'dev_1', request)).toBe(true)
    expect(readCreation('https://phone.test', 'dev_1')).toEqual(request)
  })

  it('comes back without choices the user never made', () => {
    writeCreation('https://phone.test', 'dev_1', {
      key: 'receipt-0002',
      projectId: 'proj_1',
      driverKind: '',
      modelId: '',
      effort: null,
      permissionMode: null,
      draft: '',
    })
    expect(readCreation('https://phone.test', 'dev_1')).toEqual({
      key: 'receipt-0002',
      projectId: 'proj_1',
      driverKind: '',
      modelId: '',
      effort: null,
      permissionMode: null,
      draft: '',
    })
  })
})
