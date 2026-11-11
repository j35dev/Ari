// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { COMPUTERS_KEY, computerAddress, computerDestination, forgetComputerState, readComputers, saveComputer, takeComputerDirectory, writeComputers } from './computers'
const one = 'https://studio.test-tailnet.ts.net:8443'
const two = 'https://travel.test-tailnet.ts.net'
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/') })
describe('computer directory boundary', () => {
  it('migrates the remembered origin, canonicalizes ports and preserves existing records', () => {
    localStorage.setItem('ari.remote.origin', one)
    const computers = saveComputer(readComputers(), `${one}/#pair=private`, 'Studio')
    writeComputers(saveComputer(computers, two, 'Travel'))
    expect(readComputers().map(({ origin, name }) => ({ origin, name }))).toEqual([{ origin: one, name: 'Studio' }, { origin: two, name: 'Travel' }])
    expect(localStorage.getItem(COMPUTERS_KEY)).not.toContain('pair=')
  })
  it('rejects unsafe and non-tailnet destinations while allowing explicit loopback fixtures', () => {
    for (const address of ['http://studio.ts.net', 'https://user:secret@studio.ts.net', 'javascript:alert(1)', 'https://external.example', `${one}/api`])
      expect(() => computerAddress(address)).toThrow()
    expect(computerAddress('http://127.0.0.1:5273').origin).toBe('http://127.0.0.1:5273')
  })
  it('navigates to the destination root with only public names and addresses, preserving pair fragments', () => {
    const computers = saveComputer(saveComputer([], one, 'Studio'), two, 'Travel')
    computers[0]!.lastConnectedAt = 123
    const destination = computerDestination(`${two}/?session=same#pair=invite`, computers)
    expect(new URL(destination).origin).toBe(two)
    expect(new URL(destination).search).toBe('')
    expect(destination).not.toContain('lastConnectedAt')
    const localDestination = `${location.origin}/${new URL(destination).hash}`
    expect(takeComputerDirectory(localDestination, []).map((item) => item.origin)).toEqual([one, two])
    expect(location.hash).toBe('#pair=invite')
  })
  it('forgets only the selected computer even when a similar origin or session ID exists', () => {
    for (const prefix of ['draft', 'pending', 'creation', 'fork', 'integration', 'terminal']) {
      sessionStorage.setItem(`ari.${prefix}:${one}:phone:same`, 'one')
      sessionStorage.setItem(`ari.${prefix}:${two}:phone:same`, 'two')
      sessionStorage.setItem(`ari.${prefix}:${one}0:phone:same`, 'other')
    }
    forgetComputerState(one)
    expect(sessionStorage.length).toBe(12)
    expect(sessionStorage.getItem(`ari.pending:${two}:phone:same`)).toBe('two')
  })
  it('ignores invalid saved entries and never restores connected status as live proof', () => {
    localStorage.setItem(COMPUTERS_KEY, JSON.stringify([{ origin: one, name: 'Studio', status: 'connected', lastConnectedAt: 123 }, { origin: 'file:///private' }]))
    expect(readComputers()).toEqual([{ origin: one, name: 'Studio', status: 'unreachable', lastConnectedAt: 123 }])
  })
})
