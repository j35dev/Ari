import { useSyncExternalStore } from 'react'
import type { SpeechProgress, SpeechStatus } from '@ari/contracts/rpc'
import { rpc } from '../../lib/rpc'

let snapshot: { status: SpeechStatus; progress: Record<string, SpeechProgress> } = {
  status: { engine: 'missing', model: null, ready: false },
  progress: {},
}
const listeners = new Set<() => void>()
let unsubscribe: (() => void) | null = null
let reading: Promise<void> | null = null
let revision = 0
let generation = 0

function emit(): void {
  for (const listener of listeners) listener()
}

async function refresh(): Promise<void> {
  revision++
  if (reading) return reading
  const currentGeneration = generation
  reading = (async () => {
    let readRevision: number
    do {
      readRevision = revision
      const status = await rpc.invoke('speech.status')
      if (currentGeneration !== generation) return
      snapshot = { ...snapshot, status }
      emit()
    } while (revision !== readRevision)
  })().finally(() => {
    if (currentGeneration === generation) reading = null
  })
  return reading
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    const currentGeneration = ++generation
    unsubscribe = rpc.subscribe('speech.progress', {}, (payload) => {
      if (currentGeneration !== generation) return
      const frame = payload as SpeechProgress
      snapshot = { ...snapshot, progress: { ...snapshot.progress, [frame.id]: frame } }
      emit()
      if (['complete', 'error', 'cancelled'].includes(frame.phase)) {
        void refresh().catch(() => undefined)
      }
    })
    void refresh().catch(() => undefined)
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      generation++
      unsubscribe?.()
      unsubscribe = null
      reading = null
    }
  }
}

export function useSpeech() {
  return { ...useSyncExternalStore(subscribe, () => snapshot), refresh }
}
