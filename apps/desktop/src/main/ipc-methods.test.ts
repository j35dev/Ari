import { describe, expect, it } from 'vitest'
import { rpcParams } from '@ari/contracts/rpc'
import { IPC_METHODS } from './ipc-methods'

describe('IPC_METHODS', () => {
  it('registers an ipcMain.handle for every contracts method — a miss makes the renderer invoke reject as unknown', () => {
    const listed = new Set<string>(IPC_METHODS)
    expect(listed.size).toBe(IPC_METHODS.length)
    for (const method of Object.keys(rpcParams)) {
      expect(
        listed.has(method),
        `${method} has a registry handler but no ipcMain.handle — unreachable from the renderer`,
      ).toBe(true)
    }
  })
})
