import type { PickedElement } from '@ari/contracts/rpc'
import { formatElementContexts, elementChipLabel } from './element-context'
import {
  readSessionDraftIntent,
  updateSessionDraftIntent,
  subscribeDraftIntent,
  type DraftImage,
} from '../composer/draft-recovery-store'

export interface BrowserPick {
  id: string
  element: PickedElement
  image: File | null
  imageIntent?: DraftImage
}

let picks: BrowserPick[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function subscribeBrowserPicks(listener: () => void): () => void {
  listeners.add(listener)
  const unsubscribe = subscribeDraftIntent(listener)
  return () => {
    listeners.delete(listener)
    unsubscribe()
  }
}

export function browserPicksState(sessionId?: string): readonly BrowserPick[] {
  return sessionId ? readSessionDraftIntent(sessionId).picks : picks
}

export function addBrowserPick(
  element: PickedElement,
  image: File | null,
  sessionId?: string,
): BrowserPick {
  const pick: BrowserPick = { id: crypto.randomUUID(), element, image }
  if (sessionId) restoreBrowserPicks([...browserPicksState(sessionId), pick], sessionId)
  else {
    picks = [...picks, pick]
    emit()
  }
  return pick
}

export function removeBrowserPick(id: string, sessionId?: string): void {
  if (sessionId)
    restoreBrowserPicks(
      browserPicksState(sessionId).filter((pick) => pick.id !== id),
      sessionId,
    )
  else {
    picks = picks.filter((pick) => pick.id !== id)
    emit()
  }
}

export function takeBrowserPicks(sessionId?: string): BrowserPick[] {
  const taken = [...browserPicksState(sessionId)]
  restoreBrowserPicks([], sessionId)
  return taken
}

export function restoreBrowserPicks(next: readonly BrowserPick[], sessionId?: string): void {
  if (sessionId) updateSessionDraftIntent(sessionId, (state) => ({ ...state, picks: next }))
  else {
    picks = [...next]
    emit()
  }
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
