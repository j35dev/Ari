import { describe, expect, it } from 'vitest'
import { isStopEscape, transcriptOwnsEscape } from './escape-stop'

const esc = (over: Partial<Parameters<typeof isStopEscape>[0]> = {}) => ({
  key: 'Escape',
  defaultPrevented: false,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  nativeEvent: { isComposing: false },
  ...over,
})

describe('isStopEscape', () => {
  it('accepts only a bare Esc nobody claimed', () => {
    expect(isStopEscape(esc())).toBe(true)
    expect(isStopEscape(esc({ key: 'Enter' }))).toBe(false)
    expect(isStopEscape(esc({ defaultPrevented: true }))).toBe(false)
    expect(isStopEscape(esc({ ctrlKey: true }))).toBe(false)
    expect(isStopEscape(esc({ nativeEvent: { isComposing: true } }))).toBe(false)
  })
})

describe('transcriptOwnsEscape', () => {
  it('owns Esc on the transcript but not in its fields, menus, or outside it', () => {
    const container = document.createElement('div')
    container.innerHTML = `
      <button id="toggle">Thought</button>
      <textarea id="comment"></textarea>
      <div role="menu"><button id="item">Copy</button></div>`
    document.body.append(container)
    const outside = document.createElement('button')
    document.body.append(outside)
    const byId = (id: string) => container.querySelector(`#${id}`)

    expect(transcriptOwnsEscape(container, container)).toBe(true)
    expect(transcriptOwnsEscape(container, byId('toggle'))).toBe(true)
    expect(transcriptOwnsEscape(container, byId('comment'))).toBe(false)
    expect(transcriptOwnsEscape(container, byId('item'))).toBe(false)
    expect(transcriptOwnsEscape(container, outside)).toBe(false)
    container.remove()
    outside.remove()
  })
})
