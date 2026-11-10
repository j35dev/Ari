import { afterEach, expect, it } from 'vitest'
import { captureTextTarget } from './target'

afterEach(() => document.body.replaceChildren())
function input(): HTMLTextAreaElement {
  const field = document.createElement('textarea')
  document.body.append(field)
  field.value = 'before OLD after'
  field.focus()
  field.setSelectionRange(7, 10)
  return field
}
it('inserts at the captured selection without replacing surrounding text or sending', async () => {
  const field = input()
  await captureTextTarget(field).insert('new')
  expect(field.value).toBe('before new after')
  expect(field.selectionStart).toBe(10)
})
it.each(['focus', 'blur', 'caret', 'edit', 'disabled', 'readonly', 'session', 'removed', 'cancel'])(
  'rejects a stale %s target',
  async (change) => {
    const field = input()
    const target = captureTextTarget(field)
    if (change === 'focus') {
      const other = input()
      other.focus()
      field.focus()
    }
    if (change === 'blur') {
      field.blur()
      field.focus()
    }
    if (change === 'caret') field.setSelectionRange(0, 0)
    if (change === 'edit') {
      field.value += '!'
      field.dispatchEvent(new Event('input'))
    }
    if (change === 'disabled') field.disabled = true
    if (change === 'readonly') field.readOnly = true
    if (change === 'session') field.dataset.dictationSession = 'another'
    if (change === 'removed') field.remove()
    if (change === 'cancel') target.cancel()
    const before = field.value
    await expect(target.insert('new')).rejects.toThrow('target changed')
    expect(field.value).toBe(before)
  },
)
it('treats whitespace and cancellation as no insertion', async () => {
  const field = input()
  await captureTextTarget(field).insert('   ')
  expect(field.value).toBe('before OLD after')
})
it('rejects passwords, disabled inputs and non-text controls', () => {
  const field = document.createElement('input')
  document.body.append(field)
  field.type = 'password'
  expect(() => captureTextTarget(field)).toThrow('unavailable')
  expect(() => captureTextTarget(document.body)).toThrow('Focus a text field')
})
it('rejects a field that became a password input after capture', async () => {
  const field = document.createElement('input')
  document.body.append(field)
  field.value = 'draft'
  field.focus()
  field.setSelectionRange(1, 1)
  const target = captureTextTarget(field)
  field.type = 'password'
  await expect(target.insert('dictated')).rejects.toThrow('target changed')
  expect(field.value).toBe('draft')
})

it('appends repeated utterances with one space and moves the caret past the inserted text', async () => {
  const field = input()
  field.value = 'First sentence.'
  field.setSelectionRange(field.value.length, field.value.length)
  await captureTextTarget(field).insert('Second sentence.')
  await captureTextTarget(field).insert('Third sentence.')
  expect(field.value).toBe('First sentence. Second sentence. Third sentence.')
  expect(field.selectionStart).toBe(field.value.length)
})

it('keeps neighboring draft text when replacing an inline selection with multiline speech', async () => {
  const field = input()
  field.value = 'prefixOLDsuffix'
  field.setSelectionRange(6, 9)
  const text = 'Please check:\n1. Logs.\n2. Tests.'
  await captureTextTarget(field).insert(text)
  expect(field.value).toBe('prefix ' + text + ' suffix')
  expect(field.selectionStart).toBe(6 + text.length + 2)
})

it('inserts a standalone paragraph command, then continues repeated speech on the new paragraph', async () => {
  const field = input()
  field.value = 'First sentence.'
  field.setSelectionRange(field.value.length, field.value.length)
  await captureTextTarget(field).insert('\n\n')
  await captureTextTarget(field).insert('Second sentence.')
  expect(field.value).toBe('First sentence.\n\nSecond sentence.')
})
