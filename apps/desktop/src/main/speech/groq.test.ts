// @vitest-environment node
import { expect, it, vi } from 'vitest'
import { GroqSpeech, pcmWav, withLocalFallback, GROQ_SPEECH_MODEL } from './groq'

it('sends only the short spoken clause and documented model parameters', async () => {
  const request = vi.fn(async () => new Response(pcmWav(new Float32Array(20), 24000) as BodyInit))
  const groq = new GroqSpeech(async () => 'test-key', request as unknown as typeof fetch)
  await groq.speak('The changes are ready.', 'troy', new AbortController().signal)
  const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://api.groq.com/openai/v1/audio/speech')
  expect(JSON.parse(options.body as string)).toEqual({ model: GROQ_SPEECH_MODEL, input: 'The changes are ready.', voice: 'troy', response_format: 'wav' })
  expect(options.redirect).toBe('error')
})
it('uploads only a mono WAV recording with the selected Whisper model', async () => {
  const request = vi.fn(async () => Response.json({ text: 'Please run the checks.' }))
  const groq = new GroqSpeech(async () => 'test-key', request as unknown as typeof fetch)
  expect(await groq.transcribe(new Float32Array(160), 'whisper-large-v3-turbo', 'en')).toEqual({ text: 'Please run the checks.' })
  const [, options] = request.mock.calls[0] as unknown as [string, RequestInit]
  const form = options.body as FormData
  expect([...form.keys()]).toEqual(['file', 'model', 'response_format', 'language'])
  expect(form.get('model')).toBe('whisper-large-v3-turbo')
})
it.each([401, 429, 503])('falls back locally on status %s without leaking remote error content', async status => {
  const groq = new GroqSpeech(async () => 'secret-key', vi.fn(async () => new Response('secret-key private body', { status })) as typeof fetch)
  const local = vi.fn(async () => new Uint8Array([1])); const notify = vi.fn()
  expect(await withLocalFallback(() => groq.speak('Ready.', 'troy', new AbortController().signal), local, notify)).toEqual(new Uint8Array([1]))
  expect(notify.mock.calls[0]?.[0]).toBe(`Groq speech failed (${status}). Using local speech.`)
})
it('falls back when no key exists and does not fall back after interruption', async () => {
  const request = vi.fn(); const local = vi.fn(async () => 'local')
  const groq = new GroqSpeech(async () => null, request)
  await expect(groq.speak('Ready.', 'troy', new AbortController().signal)).rejects.toThrow('no API key')
  expect(request).not.toHaveBeenCalled()
  const controller = new AbortController(); controller.abort()
  await expect(withLocalFallback(async () => { throw new Error('cancelled') }, local, vi.fn(), controller.signal)).rejects.toThrow()
  expect(local).not.toHaveBeenCalled()
})
it('enforces the current speech input limit', async () => {
  const groq = new GroqSpeech(async () => 'key', vi.fn())
  await expect(groq.speak('x'.repeat(201), 'troy', new AbortController().signal)).rejects.toThrow('Invalid')
})
