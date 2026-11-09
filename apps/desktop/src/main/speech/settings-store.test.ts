// @vitest-environment node
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { SettingsStore } from '@ari/engine/settings'
import { defaultSpeechShortcut } from '@ari/contracts/settings'

it('persists speech selection and merges shortcut updates without losing the model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-speech-settings-'))
  try {
    const store = new SettingsStore({ dir })
    await store.load()
    await store.update({
      speech: { modelId: 'tiny', modelPath: '/models/tiny.gguf', enabled: true },
    })
    await store.update({ speech: { shortcut: 'ctrl+alt+space' } })
    const reloaded = await new SettingsStore({ dir }).load()
    expect(reloaded.speech).toEqual({
      modelId: 'tiny',
      modelPath: '/models/tiny.gguf',
      enabled: true,
      shortcut: 'ctrl+alt+space',
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

it('replaces a retired shortcut on load and persists the migration without changing the model', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ari-speech-settings-'))
  try {
    const path = join(dir, 'settings.json')
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        speech: {
          modelId: 'tiny',
          modelPath: '/models/tiny.gguf',
          enabled: true,
          shortcut: 'alt-right',
        },
      }),
    )
    const store = new SettingsStore({ dir })
    expect((await store.load()).speech).toEqual({
      modelId: 'tiny',
      modelPath: '/models/tiny.gguf',
      enabled: true,
      shortcut: defaultSpeechShortcut(process.platform),
    })
    expect(JSON.parse(await readFile(path, 'utf8')).speech.shortcut).toBe(
      defaultSpeechShortcut(process.platform),
    )
    await expect(store.update({ speech: { shortcut: 'alt-right' } })).rejects.toThrow()
    expect(store.current.speech.shortcut).toBe(defaultSpeechShortcut(process.platform))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
