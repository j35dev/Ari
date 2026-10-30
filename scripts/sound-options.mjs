import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

const sampleRate = 48_000
const kinds = ['complete', 'attention', 'error']
const profiles = [
  { id: 'current', name: 'Current Ari', tag: 'Reference', description: 'The existing two-note sine pings. Same pitches and envelopes; preview level matched.', attack: 0.014, partials: [[1, 1, 1]], cues: {
    complete: [[587.33, 0, 0.3, 0.16], [880, 0.1, 0.4, 0.14]],
    attention: [[783.99, 0, 0.28, 0.15], [1174.66, 0.09, 0.36, 0.14]],
    error: [[392, 0, 0.34, 0.13], [311.13, 0.13, 0.42, 0.12]],
  } },
  { id: 'soft-glass', name: 'Soft Glass', tag: 'First pick', description: 'A rounded glass-mallet lift. Clear, refined, and less piercing than a plain ping.', attack: 0.012, partials: [[1, 1, 1], [2, 0.14, 0.45], [2.76, 0.09, 0.3]], cues: {
    complete: [[523.25, 0, 0.32], [659.25, 0.085, 0.36]],
    attention: [[659.25, 0, 0.22], [659.25, 0.19, 0.22], [783.99, 0.32, 0.28]],
    error: [[440, 0, 0.26], [349.23, 0.11, 0.3]],
  } },
  { id: 'warm-felt', name: 'Warm Felt', tag: 'Focus pick', description: 'Muted, woody keys with a warm little resolve. My pick for lots of running agents.', attack: 0.008, partials: [[1, 1, 1], [2, 0.32, 0.55], [3, 0.07, 0.25]], cues: {
    complete: [[329.63, 0, 0.2], [392, 0.065, 0.22], [523.25, 0.135, 0.24]],
    attention: [[440, 0, 0.16], [440, 0.18, 0.16], [523.25, 0.34, 0.2]],
    error: [[349.23, 0, 0.2], [293.66, 0.1, 0.23]],
  } },
  { id: 'quiet-relay', name: 'Quiet Relay', tag: 'Shortest', description: 'A dry, tactile tick-tock. More instrument-panel confirmation than musical chime.', attack: 0.004, glide: 0.9, noise: 0.4, partials: [[1, 1, 1], [2, 0.2, 0.45]], cues: {
    complete: [[620, 0, 0.08], [880, 0.095, 0.075]],
    attention: [[720, 0, 0.065], [720, 0.17, 0.065], [960, 0.34, 0.075]],
    error: [[410, 0, 0.1], [290, 0.1, 0.1]],
  } },
  { id: 'orbit', name: 'Orbit', tag: 'Airy', description: 'A small, soft-focus chord bloom. More atmosphere and identity; a little more present.', attack: 0.045, partials: [[1, 0.8, 1], [1.006, 0.2, 1], [2, 0.08, 0.5]], cues: {
    complete: [[392, 0, 0.4], [587.33, 0.035, 0.43], [783.99, 0.09, 0.44]],
    attention: [[523.25, 0, 0.2], [783.99, 0.035, 0.22], [523.25, 0.29, 0.23], [880, 0.325, 0.25]],
    error: [[523.25, 0, 0.25], [440, 0.08, 0.3], [349.23, 0.16, 0.32]],
  } },
  { id: 'droplet', name: 'Droplet', tag: 'Playful', description: 'A smooth, liquid pop with a tiny bounce. Friendlier and more organic, less serious.', attack: 0.007, glide: 0.7, partials: [[1, 1, 1], [2, 0.07, 0.35]], cues: {
    complete: [[440, 0, 0.19], [660, 0.085, 0.17]],
    attention: [[660, 0, 0.15], [660, 0.21, 0.15], [825, 0.345, 0.18]],
    error: [[330, 0, 0.24], [247, 0.105, 0.21]],
  } },
]

function render(id, kind, matchLevel = true) {
  const profile = profiles.find((entry) => entry.id === id)
  if (!profile || !kinds.includes(kind)) throw new Error(`Unknown sound: ${id}/${kind}`)
  const notes = profile.cues[kind]
  const duration = Math.max(...notes.map(([, at, length]) => at + length)) + 0.09
  const samples = new Float32Array(Math.ceil(duration * sampleRate))
  notes.forEach(([frequency, at, length, gain = 0.14], noteIndex) => {
    let seed = (profiles.indexOf(profile) + 1) * 77 + noteIndex * 101 + kinds.indexOf(kind) * 113
    let noise = 0
    const first = Math.ceil((at + 0.02) * sampleRate)
    const last = Math.min(samples.length, Math.ceil((at + 0.04 + length) * sampleRate))
    for (let i = first; i < last; i++) {
      const age = i / sampleRate - at - 0.02
      const phase = 2 * Math.PI * frequency * (age + (profile.glide ?? 0) * 0.035 * (1 - Math.exp(-age / 0.035)))
      const envelope = (decay) => age < profile.attack ? gain * age / profile.attack
        : gain * (0.0001 / gain) ** Math.min(1, (age - profile.attack) / (length * decay - profile.attack))
      let value = profile.partials.reduce((sum, [ratio, amount, decay]) => sum + Math.sin(phase * ratio) * amount * envelope(decay), 0)
      if (profile.noise) {
        seed = (Math.imul(1664525, seed) + 1013904223) >>> 0
        noise += 0.16 * (seed / 2147483648 - 1 - noise)
        value += noise * profile.noise * envelope(0.28)
      }
      const release = profile.id === 'current' ? 1 : Math.min(1, Math.max(0, (length + 0.02 - age) / 0.02))
      samples[i] += value * release
    }
  })
  if (matchLevel) {
    const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
    const active = samples.filter((value) => Math.abs(value) > peak * 0.03)
    const rms = Math.sqrt(active.reduce((sum, value) => sum + value * value, 0) / active.length)
    const scale = Math.min(0.045 / rms, 0.24 / peak)
    for (let i = 0; i < samples.length; i++) samples[i] *= scale
  }
  return samples
}

function wav(samples) {
  const buffer = Buffer.alloc(44 + samples.length * 2)
  buffer.write('RIFF', 0); buffer.writeUInt32LE(buffer.length - 8, 4); buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24); buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34); buffer.write('data', 36)
  buffer.writeUInt32LE(samples.length * 2, 40)
  samples.forEach((value, i) => {
    if (!Number.isFinite(value) || Math.abs(value) > 1) throw new Error('Invalid PCM sample')
    buffer.writeInt16LE(Math.round(value * (value < 0 ? 32768 : 32767)), 44 + i * 2)
  })
  return buffer
}

function waveform(samples) {
  const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
  return Array.from({ length: 72 }, (_, i) => {
    const slice = samples.subarray(Math.floor(i * samples.length / 72), Math.floor((i + 1) * samples.length / 72))
    const height = Math.max(1, slice.reduce((max, value) => Math.max(max, Math.abs(value)), 0) / peak * 19)
    return `M${i * 4 + 2},${22 - height}v${height * 2}`
  }).join(' ')
}

/** Original cue catalog, deterministic 48 kHz synthesis, and mono PCM16 WAV encoding for the audition study. */
export const soundStudy = { sampleRate, kinds, profiles, render, wav, waveform }

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const output = join(root, '.ari/sound-options')
  mkdirSync(join(output, 'clips'), { recursive: true })
  const catalog = profiles.map((profile) => ({
    id: profile.id, name: profile.name, tag: profile.tag, description: profile.description,
    cues: Object.fromEntries(kinds.map((kind) => {
      const samples = render(profile.id, kind)
      const url = `clips/${profile.id}-${kind}.wav`
      writeFileSync(join(output, url), wav(samples))
      if (profile.id === 'current') writeFileSync(join(output, `clips/current-${kind}-original.wav`), wav(render(profile.id, kind, false)))
      return [kind, { url, duration: Math.round(samples.length / sampleRate * 1000), waveform: waveform(samples) }]
    })),
  }))
  copyFileSync(new URL('./sound-options/index.html', import.meta.url), join(output, 'index.html'))
  copyFileSync(join(root, 'packages/ui/src/tokens.css'), join(output, 'tokens.css'))
  for (const font of ['geist', 'geist-mono']) {
    const source = join(root, `packages/ui/node_modules/@fontsource-variable/${font}`)
    copyFileSync(join(source, `files/${font}-latin-wght-normal.woff2`), join(output, `${font}.woff2`))
    copyFileSync(join(source, 'LICENSE'), join(output, `${font}-LICENSE.txt`))
  }
  writeFileSync(join(output, 'catalog.js'), `globalThis.ariSoundCatalog = ${JSON.stringify(catalog)};\n`)
  writeFileSync(join(output, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`)
  console.log(`Built 18 level-matched cues + 3 original-gain references in ${output}`)
}
