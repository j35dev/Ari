import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

/** Check the runtime, not the GPU's presence. CPU builds cannot accelerate inference. */
export async function acceleratedVoiceProvider(): Promise<'dml' | 'coreml' | null> {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return null
  const require = createRequire(import.meta.url)
  const platform = process.platform === 'win32' ? 'win' : 'darwin'
  try {
    const directory = dirname(require.resolve(`sherpa-onnx-${platform}-${process.arch}`))
    const file = process.platform === 'win32' ? 'onnxruntime.dll' : 'libonnxruntime.dylib'
    const bytes = await readFile(join(directory, file))
    const symbol = process.platform === 'win32' ? 'OrtSessionOptionsAppendExecutionProvider_DML' : 'OrtSessionOptionsAppendExecutionProvider_CoreML'
    return bytes.includes(Buffer.from(symbol)) ? (process.platform === 'win32' ? 'dml' : 'coreml') : null
  } catch { return null }
}

/** Require a meaningful win; measurement noise must not select a fallback labelled GPU. */
export function fasterVoiceProvider(cpu: number, accelerated: number): boolean {
  return Number.isFinite(accelerated) && accelerated > 0 && accelerated < cpu * 0.85
}
