import type { PickedElement } from '@ari/contracts/rpc'
import { formatElementContexts, elementChipLabel } from './element-context'

export interface BrowserPick {
  id: string
  element: PickedElement
  image: File | null
}

let picks: BrowserPick[] = []
const listeners = new Set<() => void>()
let seq = 0

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribeBrowserPicks(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function browserPicksState(): readonly BrowserPick[] {
  return picks
}

export function addBrowserPick(element: PickedElement, image: File | null): BrowserPick {
  const pick: BrowserPick = { id: `el_${++seq}`, element, image }
  picks = [...picks, pick]
  emit()
  return pick
}

export function removeBrowserPick(id: string): void {
  picks = picks.filter((pick) => pick.id !== id)
  emit()
}

export function takeBrowserPicks(): BrowserPick[] {
  const taken = picks
  picks = []
  emit()
  return taken
}

export function restoreBrowserPicks(next: readonly BrowserPick[]): void {
  picks = [...next]
  emit()
}

export function promptForPicks(items: readonly BrowserPick[]): string {
  return formatElementContexts(items.map((pick) => pick.element))
}

export function chipLabelFor(pick: BrowserPick): string {
  return elementChipLabel(pick.element)
}

export function fileFromPngBase64(base64: string, name: string): File {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new File([bytes], name, { type: 'image/png' })
}
