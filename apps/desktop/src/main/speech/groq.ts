/** Speech-only Groq client. Never logs keys, request bodies, or remote error bodies. */
export const GROQ_SPEECH_MODEL = 'canopylabs/orpheus-v1-english'
export const GROQ_VOICES = ['autumn', 'diana', 'hannah', 'austin', 'daniel', 'troy'] as const
const base = 'https://api.groq.com/openai/v1/audio/'

export function pcmWav(pcm: Float32Array, rate = 16000): Uint8Array {
  const data = new Uint8Array(44 + pcm.length * 2)
  const view = new DataView(data.buffer)
  const label = (at: number, text: string) => { for (let i = 0; i < text.length; i++) data[at + i] = text.charCodeAt(i) }
  label(0, 'RIFF'); view.setUint32(4, data.length - 8, true); label(8, 'WAVEfmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); label(36, 'data')
  view.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, pcm[i]!)) * 32767), true)
  return data
}

export class GroqSpeech {
  constructor(private readonly key: () => Promise<string | null>, private readonly request: typeof fetch = fetch) {}

  private async call(endpoint: string, body: BodyInit, signal?: AbortSignal, json = false): Promise<Response> {
    const key = await this.key()
    if (!key) throw new Error('Groq has no API key. Using local speech.')
    let result: Response
    try {
      result = await this.request(base + endpoint, {
        method: 'POST', body, redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${key}`, ...(json ? { 'Content-Type': 'application/json' } : {}) },
      })
    } catch {
      signal?.throwIfAborted()
      throw new Error('Groq could not be reached. Using local speech.')
    }
    if (!result.ok) {
      await result.body?.cancel()
      throw new Error(`Groq speech failed (${result.status}). Using local speech.`)
    }
    return result
  }

  async transcribe(pcm: Float32Array, model: string, language?: string, signal?: AbortSignal): Promise<{ text: string }> {
    if (!['whisper-large-v3-turbo', 'whisper-large-v3'].includes(model)) throw new Error('Unknown Groq speech model.')
    if (pcm.length * 2 + 44 > 25_000_000) throw new Error('This recording exceeds Groq’s 25 MB upload limit. Using local speech.')
    const form = new FormData()
    form.append('file', new Blob([pcmWav(pcm) as BlobPart], { type: 'audio/wav' }), 'speech.wav')
    form.append('model', model); form.append('response_format', 'json')
    if (language) form.append('language', language)
    const response = await this.call('transcriptions', form, signal)
    let result: { text?: unknown }
    try { result = await response.json() as { text?: unknown } }
    catch { throw new Error('Groq returned an invalid transcription. Using local speech.') }
    if (typeof result.text !== 'string') throw new Error('Groq returned no transcription. Using local speech.')
    return { text: result.text }
  }

  async speak(text: string, voice: string, signal: AbortSignal): Promise<Uint8Array> {
    if (!text || text.length > 200 || !(GROQ_VOICES as readonly string[]).includes(voice)) throw new Error('Invalid Groq spoken clause.')
    const response = await this.call('speech', JSON.stringify({ model: GROQ_SPEECH_MODEL, voice, input: text, response_format: 'wav' }), signal, true)
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Groq returned no audio. Using local speech.')
    const chunks: Uint8Array[] = []; let size = 0
    try {
      while (true) {
        const value = await reader.read(); signal.throwIfAborted()
        if (value.done) break
        size += value.value.length
        if (size > 20_000_000) throw new Error('Groq returned too much audio. Using local speech.')
        chunks.push(value.value)
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    const audio = new Uint8Array(size); let offset = 0
    for (const chunk of chunks) { audio.set(chunk, offset); offset += chunk.length }
    if (new TextDecoder().decode(audio.slice(0, 4)) !== 'RIFF') throw new Error('Groq returned invalid audio. Using local speech.')
    return audio
  }
}

export async function withLocalFallback<T>(cloud: () => Promise<T>, local: () => Promise<T>, notify: (message: string) => void, signal?: AbortSignal): Promise<T> {
  try { return await cloud() }
  catch (error) {
    signal?.throwIfAborted()
    notify(error instanceof Error ? error.message : 'Groq failed. Using local speech.')
    return local()
  }
}
