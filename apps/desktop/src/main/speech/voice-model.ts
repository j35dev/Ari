import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SpeechModel } from '@ari/contracts/rpc'

export const KOKORO_ID = 'kokoro-82m-v1.0'
export const KOKORO_FILES = [
  {
    name: 'model.onnx',
    size: 325560556,
    sha256: 'b40f62b166ac8164b0627ef48a0b358eda0985e272fb03ef5252e7206305da11',
  },
  {
    name: 'voices.bin',
    size: 28200960,
    sha256: '1c5a5b983d3d50d8586d437a51f3faa2da7919ce76a013c081e65671a3447c29',
  },
  {
    name: 'lexicon-us-en.txt',
    size: 5956885,
    sha256: '7daaab53a181be9885b853a8582bf1838186317e5dadacbcef9c426d6fa0da14',
  },
  {
    name: 'tokens.txt',
    size: 687,
    sha256: '6ebb6bb288f20f3ae8d004d3c2ca27697da27c037d75e81a60e2a6a663f95425',
  },
] as const
export const KOKORO_MODEL: Omit<SpeechModel, 'installed'> = {
  id: KOKORO_ID,
  kind: 'tts',
  name: 'Kokoro English',
  description: 'Natural local voice. Apache-2.0. About 675 MB RAM while loaded.',
  languages: ['en'],
  filename: KOKORO_ID,
  size: KOKORO_FILES.reduce((n, f) => n + f.size, 0),
  sha256: null,
  repository: 'csukuangfj/kokoro-multi-lang-v1_0',
  revision: 'f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b',
}

export async function discoverVoiceModel(root: string): Promise<SpeechModel> {
  const path = join(root, KOKORO_ID)
  const files = await Promise.all(
    KOKORO_FILES.map((f) => stat(join(path, f.name)).catch(() => null)),
  )
  const stamp = await readFile(join(path, 'verified.json'), 'utf8').catch(() => '')
  const installed =
    stamp === JSON.stringify(KOKORO_FILES) &&
    files.every((info, i) => info?.isFile() && info.size === KOKORO_FILES[i]!.size)
  const partials = await Promise.all(
    KOKORO_FILES.map((f) => stat(join(path, `${f.name}.partial`)).catch(() => null)),
  )
  const saved =
    files.reduce((n, f) => n + (f?.size ?? 0), 0) + partials.reduce((n, f) => n + (f?.size ?? 0), 0)
  return {
    ...KOKORO_MODEL,
    installed: installed ? { path, source: 'ari' } : false,
    ...(!installed && saved
      ? { partial: { size: saved, updatedAt: Math.max(...partials.map((f) => f?.mtimeMs ?? 0)) } }
      : {}),
  }
}
