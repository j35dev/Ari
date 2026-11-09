import workletUrl from './recorder-worklet.js?url&no-inline'

/** Area averaging avoids aliasing from simply dropping samples when downsampling. */
export function resampleMono(
  input: Float32Array,
  inputRate: number,
  outputRate = 16_000,
): Float32Array {
  if (!(inputRate > 0) || !(outputRate > 0)) throw new Error('Invalid sample rate.')
  if (inputRate === outputRate) return input.slice()
  const ratio = inputRate / outputRate
  const output = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < output.length; i++) {
    const start = i * ratio
    const end = Math.min(input.length, start + ratio)
    let value = 0
    for (let j = Math.floor(start); j < Math.ceil(end); j++) {
      value += (input[j] ?? 0) * (Math.min(end, j + 1) - Math.max(start, j))
    }
    output[i] = Math.max(-1, Math.min(1, value / (end - start)))
  }
  return output
}

export interface RecordingEvents {
  onReady?(): void
  onStopped?(): void
  onError?(error: Error): void
}

export async function startRecording(events: RecordingEvents = {}): Promise<{
  stop(): Promise<Float32Array>
  cancel(): void
  level(): number
}> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    video: false,
  })
  let context: AudioContext | null = null
  let node: AudioWorkletNode | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let ended = false
  let samples = 0
  let amplitude = 0
  let ready = false
  let failure: Error | null = null
  const chunks: Float32Array[] = []
  const cleanup = (): void => {
    if (ended) return
    ended = true
    amplitude = 0
    if (node) node.port.onmessage = null
    source?.disconnect()
    node?.disconnect()
    stream.getTracks().forEach((track) => {
      track.removeEventListener('ended', failed)
      track.stop()
    })
    if (context) void context.close().catch(() => undefined)
    events.onStopped?.()
  }
  const failed = (): void => {
    if (ended) return
    failure = new Error('Microphone capture stopped unexpectedly.')
    cleanup()
    events.onError?.(failure)
  }
  try {
    context = new AudioContext()
    await context.audioWorklet.addModule(workletUrl)
    if (context.state === 'suspended') await context.resume()
    source = context.createMediaStreamSource(stream)
    node = new AudioWorkletNode(context, 'ari-speech-recorder')
    node.addEventListener('processorerror', failed)
    stream.getTracks().forEach((track) => track.addEventListener('ended', failed))
    const mute = context.createGain()
    mute.gain.value = 0
    source.connect(node)
    node.connect(mute)
    mute.connect(context.destination)
    const sampleRate = context.sampleRate
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      if (ended) return
      const remaining = sampleRate * 300 - samples
      if (remaining <= 0) {
        cleanup()
        return
      }
      const chunk = event.data.length > remaining ? event.data.slice(0, remaining) : event.data
      if (!chunk.length) return
      chunks.push(chunk)
      samples += chunk.length
      const power = chunk.reduce((sum, value) => sum + value * value, 0) / chunk.length
      amplitude = Math.min(1, Math.sqrt(power) * 4)
      if (!ready) {
        ready = true
        events.onReady?.()
      }
    }
    let stopped: Promise<Float32Array> | null = null
    return {
      stop() {
        stopped ??= Promise.resolve().then(() => {
          cleanup()
          if (failure) throw failure
          const pcm = new Float32Array(samples)
          let at = 0
          for (const chunk of chunks) {
            pcm.set(chunk, at)
            at += chunk.length
          }
          chunks.length = 0
          return resampleMono(pcm, sampleRate)
        })
        return stopped
      },
      cancel() {
        cleanup()
        chunks.length = 0
        samples = 0
      },
      level() {
        return amplitude
      },
    }
  } catch (error) {
    cleanup()
    throw error
  }
}
