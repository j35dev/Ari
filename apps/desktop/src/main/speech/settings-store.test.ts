// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { SettingsStore } from '@ari/engine/settings'

it('persists speech selection and merges shortcut updates without losing the model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-speech-settings-'))
  try {
    const store = new SettingsStore({ dir })
    await store.load()
    await store.update({
      speech: { modelId: 'tiny', modelPath: '/models/tiny.gguf', enabled: true },
    })
    await store.update({ speech: { shortcut: 'ctrl+space' } })
    const reloaded = await new SettingsStore({ dir }).load()
    expect(reloaded.speech).toEqual({
      modelId: 'tiny',
      modelPath: '/models/tiny.gguf',
      enabled: true,
      shortcut: 'ctrl+space',
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
