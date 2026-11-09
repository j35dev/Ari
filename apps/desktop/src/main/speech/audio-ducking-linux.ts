import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { OutputBackend } from './audio-ducking-state'

const exec = promisify(execFile)
export type PulseCommand = (args: string[]) => Promise<string>
const command: PulseCommand = async (args) =>
  (
    await exec('pactl', args, {
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 1500,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout

interface SinkInput {
  index: number
  client: number
  properties: Record<string, string>
  volume: Record<string, { value: number }>
}

export function pulseOutputBackend(
  excluded: () => ReadonlySet<number>,
  run = command,
): OutputBackend {
  return {
    async list() {
      const [info, json] = await Promise.all([
        run(['info']),
        run(['--format=json', 'list', 'sink-inputs']),
      ])
      const cookie = /^Cookie:\s*(.+)$/m.exec(info)?.[1]
      if (!cookie) throw new Error('PulseAudio did not provide a stable server identity')
      const inputs = JSON.parse(json) as SinkInput[]
      if (!Array.isArray(inputs)) throw new Error('Invalid PulseAudio playback stream list')
      const sessions = inputs.map((input) => {
        if (!Number.isInteger(input.index) || !input.volume)
          throw new Error('Invalid PulseAudio playback stream')
        const values = Object.values(input.volume).map((channel) => channel.value / 65536)
        return {
          id: `${cookie}:${input.index}:${input.client}:${input.properties?.['application.process.id'] ?? ''}:${input.properties?.['object.serial'] ?? ''}`,
          excluded: excluded().has(Number(input.properties?.['application.process.id'])),
          read: () => Promise.resolve(values),
          write: async (volume: number[]) => {
            await run([
              'set-sink-input-volume',
              String(input.index),
              ...volume.map((value) => String(Math.round(value * 65536))),
            ])
          },
          release: () => undefined,
        }
      })
      return { sessions, complete: true }
    },
    dispose() {},
  }
}
