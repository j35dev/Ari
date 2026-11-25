import type { VoiceAudio } from '../features/aria/voice-playback'
import type { RpcMethod, RpcResults, StreamFrame, StreamName } from '@ari/contracts/rpc'
import type { DictationBridge } from '../../../shared/dictation'
import type { SnapshotBridge } from '../../../shared/snapshots'

interface AriBridge {
  snapshots?: SnapshotBridge
  voice?: {
    onAudio: (callback: (frame: VoiceAudio) => void) => () => void
    played: (id: number, generation: number, error?: string) => void
  }
  dictation?: DictationBridge
  invoke: (method: string, params?: unknown) => Promise<unknown>
  subscribe: (id: string, callback: (frame: StreamFrame) => void) => () => void
  /** Absolute OS path for a renderer File; '' when unavailable. Absent outside Electron. */
  filePath?: (file: File) => string
}

declare global {
  interface Window {
    ari: AriBridge
  }
}

let subscriptionCounter = 0

/**
 * Electron wraps every error a main-process handler throws as "Error invoking
 * remote method 'ari:x': Error: <message>". That transport wording is noise
 * wherever the message reaches a person, so it is stripped once, here.
 */
const REMOTE_PREFIX = /^Error invoking remote method '[^']*':\s*(?:[A-Za-z]*Error:\s*)?/

export function stripRemotePrefix(message: string): string {
  return message.replace(REMOTE_PREFIX, '')
}

function bridge<T>(value: unknown): T {
  return value as T
}

/** Typed renderer-side RPC client over the sandboxed preload bridge. */
export const rpc = {
  async invoke<M extends RpcMethod>(method: M, params?: unknown): Promise<RpcResults[M]> {
    try {
      return bridge<RpcResults[M]>(await window.ari.invoke(method, params))
    } catch (error) {
      if (error instanceof Error) error.message = stripRemotePrefix(error.message)
      throw error
    }
  },

  subscribe<S extends StreamName>(
    name: S,
    params: Record<string, unknown>,
    onEvent: (payload: unknown) => void,
  ): () => void {
    const id = `sub_${++subscriptionCounter}_${Math.random().toString(36).slice(2, 8)}`
    const unsubscribeTransport = window.ari.subscribe(id, (frame) => onEvent(frame.payload))
    void window.ari.invoke('stream.subscribe', { id, name, params })
    return () => {
      unsubscribeTransport()
      void window.ari.invoke('stream.unsubscribe', { id })
    }
  },
}
