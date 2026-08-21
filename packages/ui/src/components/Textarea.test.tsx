import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Textarea, autoGrowHeight } from './Textarea'

const LINE_HEIGHT = 20
const PAD_Y = 12

function stubLayout(): void {
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    lineHeight: `${LINE_HEIGHT}px`,
    paddingTop: `${PAD_Y / 2}px`,
    paddingBottom: `${PAD_Y / 2}px`,
  } as unknown as CSSStyleDeclaration)
}

/** Force a per-element scrollHeight value (jsdom always reports 0). */
function stubScrollHeight(el: HTMLElement, value: number): void {
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    value,
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('autoGrowHeight', () => {
  it('clamps to the min row band', () => {
    expect(autoGrowHeight(4, LINE_HEIGHT, PAD_Y)).toBe(LINE_HEIGHT * 3 + PAD_Y)
  })

  it('clamps to the max row band', () => {
    expect(autoGrowHeight(10_000, LINE_HEIGHT, PAD_Y)).toBe(
      LINE_HEIGHT * 10 + PAD_Y,
    )
  })

  it('keeps in-band content heights', () => {
    const mid = LINE_HEIGHT * 5 + PAD_Y
    expect(autoGrowHeight(mid, LINE_HEIGHT, PAD_Y)).toBe(mid)
  })
})

describe('Textarea', () => {
  it('adjusts height on input via scrollHeight, capped at max rows', () => {
    stubLayout()
    render(<Textarea autoGrow defaultValue="" />)
    const el = screen.getByRole('textbox')
    stubScrollHeight(el, LINE_HEIGHT * 10 + PAD_Y + 500)

    fireEvent.input(el, { target: { value: 'line\n'.repeat(30) } })
    expect(el.style.height).toBe(`${LINE_HEIGHT * 10 + PAD_Y}px`)
    expect(el.style.overflowY).toBe('auto')
  })

  it('grows at least to the min row band on input', () => {
    stubLayout()
    render(<Textarea autoGrow defaultValue="" />)
    const el = screen.getByRole('textbox')
    stubScrollHeight(el, 4)

    fireEvent.input(el, { target: { value: 'x' } })
    expect(el.style.height).toBe(`${LINE_HEIGHT * 3 + PAD_Y}px`)
    expect(el.style.overflowY).toBe('hidden')
  })

  it('sizes once on mount for controlled values', () => {
    stubLayout()
    const content = LINE_HEIGHT * 6 + PAD_Y
    const inherited = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'scrollHeight',
    )
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      configurable: true,
      get: () => content,
    })
    try {
      render(<Textarea autoGrow value={'a\nb\nc\nd\ne\nf'} onChange={() => {}} />)
      const el = screen.getByRole('textbox')
      expect(el.style.height).toBe(`${content}px`)
      expect(el.style.overflowY).toBe('hidden')
    } finally {
      if (inherited) {
        Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', inherited)
      } else {
        Reflect.deleteProperty(HTMLTextAreaElement.prototype, 'scrollHeight')
      }
    }
  })

  it('does not manage height when autoGrow is off', () => {
    stubLayout()
    render(<Textarea defaultValue="hello" />)
    const el = screen.getByRole('textbox')
    stubScrollHeight(el, 9999)
    fireEvent.input(el, { target: { value: 'hello world' } })
    expect(el.style.height).toBe('')
  })
})
