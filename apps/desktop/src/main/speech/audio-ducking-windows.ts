import koffi from 'koffi'
import type { OutputBackend, OutputSession } from './audio-ducking-state'

type Pointer = bigint | null

/** Windows SDK GUID memory layout, including the three little-endian fields. */
export function windowsGuid(value: string): Buffer {
  const bytes = Buffer.from(value.replaceAll('-', ''), 'hex')
  if (bytes.length !== 16) throw new Error('Invalid audio interface GUID')
  bytes.subarray(0, 4).reverse()
  bytes.subarray(4, 6).reverse()
  bytes.subarray(6, 8).reverse()
  return bytes
}

export function windowsOutputBackend(excluded: () => ReadonlySet<number>): OutputBackend {
  const ole = koffi.load('ole32.dll')
  const initialize = ole.func('int32 __stdcall CoInitializeEx(void *reserved, uint32 flags)')
  const uninitialize = ole.func('void __stdcall CoUninitialize()')
  const free = ole.func('void __stdcall CoTaskMemFree(void *memory)')
  const create = ole.func(
    'int32 __stdcall CoCreateInstance(const void *clsid, void *outer, uint32 context, const void *iid, _Out_ void **result)',
  )
  const initialized = initialize(null, 0) as number
  if (initialized < 0 && initialized >>> 0 !== 0x80010106)
    throw new Error('Could not initialize Windows audio COM')
  const prototypes = new Map<string, ReturnType<typeof koffi.proto>>()
  function call(object: Pointer, slot: number, args: unknown[] = [], types: string[] = []): number {
    if (!object) throw new Error('Missing Windows audio interface')
    const key = types.join(',')
    let prototype = prototypes.get(key)
    if (!prototype) {
      prototype = koffi.proto('__stdcall', 'int32', ['void *', ...types])
      prototypes.set(key, prototype)
    }
    const vtable = koffi.decode(object, 'void *') as Pointer
    const method = koffi.decode(vtable, slot * koffi.sizeof('void *'), 'void *') as Pointer
    const result = koffi.call(method, prototype, object, ...args) as number
    if (slot !== 2 && result < 0)
      throw new Error(`Windows audio call failed: 0x${(result >>> 0).toString(16)}`)
    return result
  }
  const release = (object: Pointer): void => {
    if (object) call(object, 2)
  }
  function output(
    object: Pointer,
    slot: number,
    args: unknown[] = [],
    types: string[] = [],
  ): Pointer {
    const target: Pointer[] = [null]
    call(object, slot, [...args, target], [...types, '_Out_ void **'])
    return target[0]!
  }
  const query = (object: Pointer, iid: string): Pointer =>
    output(object, 0, [windowsGuid(iid)], ['const void *'])
  const scalar = (object: Pointer, slot: number, type: string): number => {
    const value = [0]
    call(object, slot, [value], [`_Out_ ${type} *`])
    return value[0]!
  }
  const enumerator: Pointer[] = [null]
  try {
    const result = create(
      windowsGuid('BCDE0395-E52F-467C-8E3D-C4579291692E'),
      null,
      23,
      windowsGuid('A95664D2-9614-4F35-A746-DE8DB63617E6'),
      enumerator,
    ) as number
    if (result < 0) throw new Error('Could not enumerate Windows playback devices')
  } catch (error) {
    if (initialized >= 0) uninitialize()
    throw error
  }
  let disposed = false
  return {
    list() {
      const result: OutputSession[] = []
      let complete = true
      const collection = output(enumerator[0]!, 3, [0, 15], ['int32', 'uint32']) // eRender, all device states
      try {
        for (let deviceIndex = 0; deviceIndex < scalar(collection, 3, 'uint32'); deviceIndex++) {
          const device = output(collection, 4, [deviceIndex], ['uint32'])
          let manager: Pointer = null
          let sessions: Pointer = null
          try {
            manager = output(
              device,
              3,
              [windowsGuid('77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F'), 23, null],
              ['const void *', 'uint32', 'void *'],
            )
            sessions = output(manager, 5)
            for (let index = 0; index < scalar(sessions, 3, 'int32'); index++) {
              const control = output(sessions, 4, [index], ['int32'])
              let details: Pointer = null
              let volume: Pointer = null
              try {
                details = query(control, 'BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D')
                const pid = scalar(details, 14, 'uint32')
                const own = excluded().has(pid)
                const name = output(details, 13)
                let id: string
                try {
                  id = koffi.decode(name, 'char16_t', -1) as string
                } finally {
                  free(name)
                }
                volume = query(control, '87CE5498-68D6-44E5-9215-6DA47EF883D8')
                const held = volume
                result.push({
                  id,
                  pid,
                  excluded: own,
                  read: () => Promise.resolve([scalar(held, 4, 'float')]),
                  write: (value) => {
                    call(held, 3, [value[0], null], ['float', 'const void *'])
                    return Promise.resolve()
                  },
                  release: () => release(held),
                })
                volume = null // transferred to the session owner
              } catch {
                complete = false
                // A playback stream can disappear between enumeration and QI.
              } finally {
                release(volume)
                release(details)
                release(control)
              }
            }
          } catch {
            complete = false
            // Devices may be unplugged while another endpoint remains usable.
          } finally {
            release(sessions)
            release(manager)
            release(device)
          }
        }
      } finally {
        release(collection)
      }
      return Promise.resolve({ sessions: result, complete })
    },
    dispose() {
      if (disposed) return
      disposed = true
      release(enumerator[0]!)
      if (initialized >= 0) uninitialize()
    },
  }
}
