import assert from 'node:assert/strict'
import { test } from 'node:test'
import { soundStudy } from './sound-options.mjs'

const { profiles, kinds, render, wav, sampleRate } = soundStudy

test('the reference preserves all source frequencies, times, envelopes, and original gains', () => {
  const current = profiles[0]
  assert.equal(current.attack, 0.014)
  assert.deepEqual(current.partials, [[1, 1, 1]])
  assert.deepEqual(current.cues, {
    complete: [[587.33, 0, 0.3, 0.16], [880, 0.1, 0.4, 0.14]],
    attention: [[783.99, 0, 0.28, 0.15], [1174.66, 0.09, 0.36, 0.14]],
    error: [[392, 0, 0.34, 0.13], [311.13, 0.13, 0.42, 0.12]],
  })
  const samples = render('current', 'complete', false)
  const time = 0.027, age = time - 0.02
  assert.ok(Math.abs(samples[Math.round(time * sampleRate)] - Math.sin(2 * Math.PI * 587.33 * age) * 0.16 * age / 0.014) < 1e-6)
})

for (const profile of profiles) for (const kind of kinds) {
  test(`${profile.id}/${kind}: deterministic, finite, compact, click-safe PCM and valid WAV`, () => {
    const samples = render(profile.id, kind)
    assert.deepEqual(samples, render(profile.id, kind))
    assert.ok(samples.length / sampleRate < 0.75)
    assert.ok(samples.every(Number.isFinite))
    assert.ok(samples.subarray(0, 960).every((value) => value === 0))
    assert.ok(samples.subarray(-960).every((value) => value === 0))
    const peak = samples.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
    assert.ok(peak > 0.04 && peak <= 0.241)
    const active = samples.filter((value) => Math.abs(value) > peak * 0.03)
    const rms = Math.sqrt(active.reduce((sum, value) => sum + value * value, 0) / active.length)
    assert.ok(Math.abs(rms - 0.045) < 0.001)
    const maxJump = samples.slice(1).reduce((max, value, i) => Math.max(max, Math.abs(value - samples[i])), 0)
    assert.ok(maxJump < 0.06)
    const encoded = wav(samples)
    assert.equal(encoded.toString('ascii', 0, 4), 'RIFF')
    assert.equal(encoded.toString('ascii', 8, 16), 'WAVEfmt ')
    assert.equal(encoded.readUInt32LE(4), encoded.length - 8)
    assert.equal(encoded.readUInt32LE(24), sampleRate)
    assert.equal(encoded.readUInt16LE(22), 1)
    assert.equal(encoded.readUInt16LE(34), 16)
    assert.equal(encoded.readUInt32LE(40), samples.length * 2)
    assert.equal(encoded.length, 44 + samples.length * 2)
    assert.equal((soundStudy.waveform(samples).match(/M/g) ?? []).length, 72)
  })
}

test('events remain distinct in every family, and families are not just copies', () => {
  const signatures = new Set()
  for (const profile of profiles) {
    const events = kinds.map((kind) => wav(render(profile.id, kind)).toString('base64'))
    assert.equal(new Set(events).size, 3)
    for (const event of events) signatures.add(event)
  }
  assert.equal(signatures.size, 18)
})

test('unknown cues and corrupt PCM are rejected', () => {
  assert.throws(() => render('missing', 'complete'), /Unknown sound/)
  assert.throws(() => render('soft-glass', 'missing'), /Unknown sound/)
  for (const value of [NaN, Infinity, -Infinity, 1.01, -1.01]) assert.throws(() => wav(new Float32Array([value])), /Invalid PCM/)
})
