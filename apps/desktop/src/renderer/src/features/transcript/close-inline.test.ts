import { describe, expect, it } from 'vitest'
import { closeOpenInline } from './close-inline'

describe('closeOpenInline', () => {
  it('closes bold and inline code left open by a half-written paragraph', () => {
    expect(closeOpenInline('This is **impor')).toBe('This is **impor**')
    expect(closeOpenInline('Call `useSorted')).toBe('Call `useSorted`')
    expect(closeOpenInline('Gone ~~stale')).toBe('Gone ~~stale~~')
  })

  it('leaves balanced text alone', () => {
    const text = 'Done: **bold** and `code`.'
    expect(closeOpenInline(text)).toBe(text)
  })

  it('does not count markers inside inline code', () => {
    expect(closeOpenInline('Use `a ** b` then **x')).toBe('Use `a ** b` then **x**')
  })

  it('drops a marker with nothing after it yet', () => {
    expect(closeOpenInline('The list is **')).toBe('The list is ')
    expect(closeOpenInline('Run `')).toBe('Run ')
  })

  it('only touches the last paragraph', () => {
    expect(closeOpenInline('An **odd first\n\nSecond `x')).toBe('An **odd first\n\nSecond `x`')
  })

  it('never edits inside an open fence', () => {
    const text = 'Here:\n\n```ts\nconst a = `tpl'
    expect(closeOpenInline(text)).toBe(text)
  })

  it('shows a table only once its rule row is in, and only whole rows', () => {
    expect(closeOpenInline('Results:\n\n| Case | Bef')).toBe('Results:')
    expect(closeOpenInline('| Case | Before |\n| --- | --- |\n| a | 1 |\n| b | ')).toBe(
      '| Case | Before |\n| --- | --- |\n| a | 1 |',
    )
    expect(closeOpenInline('| Case | Before |\n| --- | --- |\n| a | 1 |\n')).toBe(
      '| Case | Before |\n| --- | --- |\n| a | 1 |',
    )
  })
})
