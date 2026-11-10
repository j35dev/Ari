import koffi from 'koffi'
import type { DictationTarget } from '../../shared/dictation'
import { hasDictationText } from '../../shared/dictation-format'

// UI Automation verifies editability and pins the exact control and selection.
// SendInput uses Unicode packets: no clipboard formats are read or replaced.
const pointerSize = process.arch === 'ia32' ? 4 : 8
const user = koffi.load('user32.dll')
const ole = koffi.load('ole32.dll')
const automation = koffi.load('oleaut32.dll')
const foreground = user.func('void* __stdcall GetForegroundWindow()')
const asyncKey = user.func('short __stdcall GetAsyncKeyState(int key)')
const sendInput = user.func('uint __stdcall SendInput(uint count, void* inputs, int size)')
const initialize = ole.func('long __stdcall CoInitializeEx(void* reserved, uint flags)')
const create = ole.func(
  'long __stdcall CoCreateInstance(void* clsid, void* outer, uint context, void* iid, _Out_ void** result)',
)
const freeString = automation.func('void __stdcall SysFreeString(void* text)')
const stringLength = automation.func('uint __stdcall SysStringLen(void* text)')
const clearVariant = automation.func('long __stdcall VariantClear(void* variant)')

function guid(value: string): Buffer {
  const hex = value.replaceAll('-', '')
  const buffer = Buffer.from(hex, 'hex')
  buffer.subarray(0, 4).reverse()
  buffer.subarray(4, 6).reverse()
  buffer.subarray(6, 8).reverse()
  return buffer
}

function method(object: unknown, index: number, result: string, args: string[]) {
  const table: unknown = koffi.decode(object, 'void*')
  const address: unknown = koffi.decode(table, index * pointerSize, 'void*')
  const prototype = koffi.proto(
    `${result} __stdcall (void* self${args.length ? ', ' + args.join(', ') : ''})`,
  )
  return (...params: unknown[]): unknown => koffi.call(address, prototype, ...params)
}
function check(result: unknown): void {
  if (typeof result !== 'number' || result < 0)
    throw new Error('Windows could not access this text field. Check application permissions.')
}
function release(object: unknown): void {
  if (object) method(object, 2, 'uint', [])(object)
}
function objectResult(
  object: unknown,
  index: number,
  args: string[] = [],
  values: unknown[] = [],
): unknown {
  const out = Buffer.alloc(pointerSize)
  check(method(object, index, 'long', [...args, 'void** result'])(object, ...values, out))
  const result: unknown = koffi.decode(out, 'void*')
  if (!result) throw new Error('This application does not expose an editable text field.')
  return result
}
function boolProperty(object: unknown, id: number): boolean | null {
  const variant = Buffer.alloc(24)
  check(method(object, 10, 'long', ['int id', 'void* result'])(object, id, variant))
  try {
    return variant.readUInt16LE(0) === 11 ? variant.readInt16LE(8) !== 0 : null
  } finally {
    clearVariant(variant)
  }
}
function text(object: unknown, index: number, args: string[] = [], values: unknown[] = []): string {
  const out = Buffer.alloc(pointerSize)
  check(method(object, index, 'long', [...args, 'void** result'])(object, ...values, out))
  const result: unknown = koffi.decode(out, 'void*')
  if (!result) return ''
  try {
    return koffi.decode.string16(result, stringLength(result) as number)
  } finally {
    freeString(result)
  }
}

export interface WindowsDictationTarget extends DictationTarget {
  snapshot(): { text: string; start: number; end: number }
}

export function createWindowsDictation(): {
  capture(expectedWindow?: string): WindowsDictationTarget
} {
  // Electron may already initialize COM on this thread; RPC_E_CHANGED_MODE is fine.
  const initialized = initialize(null, 0) as number
  if (initialized < 0 && initialized !== -2147417850) check(initialized)
  const out = [null]
  check(
    create(
      guid('ff48dba4-60ef-4201-aa87-54103eef594e'),
      null,
      1,
      guid('30cbe57d-d9d0-452a-ab13-7ac5ac4825ee'),
      out,
    ),
  )
  const client = out[0]
  return {
    capture(expectedWindow) {
      const window: unknown = foreground()
      if (!window) throw new Error('Focus a text field before dictating.')
      if (expectedWindow && koffi.address(window).toString() !== expectedWindow)
        throw new Error('The dictation target changed before recording started.')
      const element = objectResult(client, 8)
      let pattern: unknown = null
      let document: unknown = null
      let selection: unknown = null
      let disposed = false
      let moved = false
      let timer: ReturnType<typeof setInterval> | undefined
      const cancel = (): void => {
        if (disposed) return
        disposed = true
        clearInterval(timer)
        release(selection)
        release(document)
        release(pattern)
        release(element)
      }
      const sameFocus = (): boolean => {
        const focusedWindow: unknown = foreground()
        if (disposed || !focusedWindow || koffi.address(focusedWindow) !== koffi.address(window))
          return false
        const focused = objectResult(client, 8)
        try {
          const same = Buffer.alloc(4)
          check(
            method(client, 3, 'long', ['void* first', 'void* second', 'int* same'])(
              client,
              element,
              focused,
              same,
            ),
          )
          return same.readInt32LE(0) !== 0
        } finally {
          release(focused)
        }
      }
      const selected = (): unknown => {
        const ranges = objectResult(pattern, 5)
        try {
          const length = Buffer.alloc(4)
          check(method(ranges, 3, 'long', ['int* length'])(ranges, length))
          if (length.readInt32LE(0) !== 1)
            throw new Error('Select a single insertion point before dictating.')
          return objectResult(ranges, 4, ['int index'], [0])
        } finally {
          release(ranges)
        }
      }
      const editable = (valuePattern: boolean): boolean => {
        const readOnly = Buffer.alloc(24)
        check(
          method(document, 9, 'long', ['int attribute', 'void* value'])(document, 40015, readOnly),
        )
        try {
          return readOnly.readUInt16LE(0) === 11 ? readOnly.readInt16LE(8) === 0 : valuePattern
        } finally {
          clearVariant(readOnly)
        }
      }
      try {
        if (boolProperty(element, 30010) !== true || boolProperty(element, 30019) !== false)
          throw new Error('Dictation is unavailable in disabled or password fields.')
        const valuePattern = boolProperty(element, 30043) === true
        if (valuePattern && boolProperty(element, 30046) !== false)
          throw new Error('This text field is read-only.')
        // TextPattern preserves the selection; ValuePattern alone cannot do that.
        if (boolProperty(element, 30040) !== true)
          throw new Error('This application does not expose a text insertion point to Windows.')
        // GetCurrentPattern returns IUnknown; request the typed TextPattern interface.
        pattern = objectResult(
          element,
          14,
          ['int patternId', 'void* iid'],
          [10014, guid('32eba289-3583-42c9-9c59-3b6d9a1e9b6a')],
        )
        document = objectResult(pattern, 7)
        if (!editable(valuePattern)) throw new Error('This text field does not allow dictation.')
        selection = selected()
        const original = text(document, 12, ['int maxLength'], [1_000_001])
        if (!sameFocus()) throw new Error('The dictation target changed before recording started.')
        if (original.length > 1_000_000)
          throw new Error('This document is too large for dictation. Use a smaller text field.')
        // The pill is non-focusable. Any other focus change invalidates this target,
        // even if the user subsequently returns to the original application.
        timer = setInterval(() => {
          try {
            if (!sameFocus()) moved = true
          } catch {
            moved = true
          }
        }, 100)
        timer.unref()
        return {
          cancel,
          snapshot() {
            if (disposed) throw new Error('The dictation target is no longer available.')
            const prefix = objectResult(document, 3)
            try {
              check(
                method(prefix, 15, 'long', ['int endpoint', 'void* other', 'int otherEndpoint'])(
                  prefix,
                  1,
                  selection,
                  0,
                ),
              )
              const start = text(prefix, 12, ['int maxLength'], [-1]).length
              return {
                text: text(document, 12, ['int maxLength'], [-1]),
                start,
                end: start + text(selection, 12, ['int maxLength'], [-1]).length,
              }
            } finally {
              release(prefix)
            }
          },
          async insert(value, current = () => true) {
            if (!hasDictationText(value)) {
              cancel()
              return
            }
            try {
              const until = Date.now() + 2_000
              const modifiers = [0x10, 0x11, 0x12, 0x5b, 0x5c]
              while (modifiers.some((key) => (asyncKey(key) as number) & 0x8000)) {
                if (Date.now() >= until || moved || !current())
                  throw new Error('Release the dictation shortcut before inserting text.')
                await new Promise((resolve) => setTimeout(resolve, 20))
              }
              if (
                moved ||
                !current() ||
                !sameFocus() ||
                boolProperty(element, 30010) !== true ||
                boolProperty(element, 30019) !== false ||
                boolProperty(element, 30046) === true ||
                !editable(valuePattern) ||
                text(document, 12, ['int maxLength'], [1_000_001]) !== original
              )
                throw new Error(
                  'The dictation target changed. Dictate again in the intended field.',
                )
              const range = selected()
              try {
                const same = Buffer.alloc(4)
                check(
                  method(selection, 4, 'long', ['void* other', 'int* same'])(
                    selection,
                    range,
                    same,
                  ),
                )
                if (!same.readInt32LE(0))
                  throw new Error(
                    'The text selection changed. Dictate again at the intended caret.',
                  )
              } finally {
                release(range)
              }
              if (value.length > 32_000) throw new Error('The dictated text is too long to insert.')
              const size = pointerSize === 8 ? 40 : 28
              const union = pointerSize === 8 ? 8 : 4
              const inputs = Buffer.alloc(size * value.length * 2)
              for (let i = 0; i < value.length; i++) {
                for (let up = 0; up < 2; up++) {
                  const at = (i * 2 + up) * size
                  inputs.writeUInt32LE(1, at)
                  inputs.writeUInt16LE(value.charCodeAt(i), at + union + 2)
                  inputs.writeUInt32LE(4 | (up ? 2 : 0), at + union + 4)
                }
              }
              if (!current() || !sameFocus()) throw new Error('The dictation target changed.')
              const count = value.length * 2
              if (sendInput(count, inputs, size) !== count)
                throw new Error(
                  'Windows could not insert dictation. The target may require different permissions.',
                )
            } finally {
              cancel()
            }
          },
        }
      } catch (error) {
        cancel()
        throw error
      }
    },
  }
}
