import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createElement, useEffect, useState, type ChangeEvent } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dispatchBrowserMcpTool } from './browser-mcp'
import type { BrowserService } from './browser-service'

// Execute exactly the source sent to the guest. This exercises real React in
// jsdom, not Electron or the currently installed Ari binary.
function service(): BrowserService {
  return {
    has: () => true,
    runScript: vi.fn(async (_tabId: string, source: string): Promise<unknown> =>
      window.eval(source),
    ),
  } as unknown as BrowserService
}

async function fill(selector: string, text: unknown) {
  return dispatchBrowserMcpTool(service(), 'browser_type', { selector, text })
}

function expectError(result: Awaited<ReturnType<typeof fill>>, message: string): void {
  expect(result.isError).toBe(true)
  expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining(message) }])
}

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  localStorage.clear()
})

describe('browser_type generated input script', () => {
  it.each(['input', 'textarea'] as const)(
    'updates controlled React %s state and persisted draft across rerenders',
    async (tag) => {
      const changed = vi.fn()
      function Draft() {
        const [draft, setDraft] = useState('old draft')
        const [revision, setRevision] = useState(0)
        useEffect(() => {
          localStorage.setItem('draft', draft)
        }, [draft])
        return createElement(
          'div',
          null,
          createElement(tag, {
            id: 'draft',
            value: draft,
            onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
              changed(event.target.value)
              setDraft(event.target.value)
            },
          }),
          createElement('output', { 'data-testid': 'state' }, draft),
          createElement(
            'button',
            { onClick: () => setRevision(revision + 1) },
            `Rerender ${revision}`,
          ),
        )
      }
      const fixture = render(createElement(Draft))
      const field = fixture.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        '#draft',
      )!
      const text = tag === 'textarea' ? 'replacement draft\nsecond line' : 'replacement draft'

      await act(async () => {
        expect(await fill('#draft', text)).toEqual({ content: [{ type: 'text', text: 'typed' }] })
      })

      expect(changed).toHaveBeenCalledExactlyOnceWith(text)
      expect(field.value).toBe(text)
      expect(screen.getByTestId('state').textContent).toBe(text)
      expect(localStorage.getItem('draft')).toBe(text)
      fireEvent.click(screen.getByRole('button', { name: 'Rerender 0' }))
      fixture.rerender(createElement(Draft))
      expect(screen.getByRole('button', { name: 'Rerender 1' })).toBeInTheDocument()
      expect(field.value).toBe(text)
      expect(screen.getByTestId('state').textContent).toBe(text)
      expect(localStorage.getItem('draft')).toBe(text)
    },
  )

  it.each(['text', 'search', 'tel', 'url', 'email', 'password'])(
    'fills a %s input and sends bubbling input and change events',
    async (type) => {
      document.body.innerHTML = `<input id="field" type="${type}" value="old">`
      const field = document.querySelector<HTMLInputElement>('#field')!
      const events: Event[] = []
      document.body.addEventListener('input', (event) => events.push(event), { once: true })
      document.body.addEventListener('change', (event) => events.push(event), { once: true })

      expect((await fill('#field', 'new')).isError).toBeUndefined()

      expect(field.value).toBe('new')
      expect(document.activeElement).toBe(field)
      expect(events.map((event) => event.type)).toEqual(['input', 'change'])
      expect(events[0]).toBeInstanceOf(InputEvent)
      expect((events[0] as InputEvent).data).toBe('new')
      expect((events[0] as InputEvent).inputType).toBe('insertReplacementText')
    },
  )

  it('keeps selector and text literals intact, replaces the whole value, and allows clearing', async () => {
    const field = document.createElement('textarea')
    const selector = '[data-field="quote\'s\\\\draft"]'
    field.setAttribute('data-field', "quote's\\draft")
    field.value = 'old draft'
    document.body.append(field)
    const text =
      '"quotes" \'single\' `ticks` ${literal} \\ path\n<img src=x onerror="alert(1)">\n😀'
    expect((await fill(selector, text)).isError).toBeUndefined()
    expect(field.value).toBe(text)
    expect(document.querySelector('img')).toBeNull()
    expect((await fill(selector, '')).isError).toBeUndefined()
    expect(field.value).toBe('')
  })

  it.each(['true', '', 'plaintext-only', 'TRUE'])(
    'fills contenteditable=%s with literal text and bubbling input',
    async (mode) => {
      document.body.innerHTML = `<div id="editor" contenteditable="${mode}"><b>old draft</b></div>`
      const editor = document.querySelector<HTMLElement>('#editor')!
      const input = vi.fn()
      editor.addEventListener('input', input)
      const text = '<b>literal</b>\n${text} `ticks` 😀'

      expect((await fill('#editor', text)).isError).toBeUndefined()

      expect(editor.textContent).toBe(text)
      expect(editor.children).toHaveLength(0)
      expect(input).toHaveBeenCalledOnce()
      expect((await fill('#editor', '')).isError).toBeUndefined()
      expect(editor.textContent).toBe('')
    },
  )

  it('supports inherited contenteditable while respecting a noneditable island', async () => {
    document.body.innerHTML =
      '<div contenteditable="true"><span id="inherited">old</span><span id="locked" contenteditable="false">locked</span></div>'
    expect((await fill('#inherited', 'new')).isError).toBeUndefined()
    expect(document.querySelector('#inherited')?.textContent).toBe('new')
    expectError(await fill('#locked', 'new'), 'not editable')
    expect(document.querySelector('#locked')?.textContent).toBe('locked')
  })

  it.each([
    ['<input id="field" disabled value="old">', 'disabled'],
    ['<fieldset disabled><textarea id="field">old</textarea></fieldset>', 'disabled'],
    ['<input id="field" readonly value="old">', 'read-only'],
    ['<textarea id="field" readonly>old</textarea>', 'read-only'],
    ['<div id="field" contenteditable="true" aria-disabled="true">old</div>', 'disabled'],
    ['<div id="field" contenteditable="true" aria-readonly="true">old</div>', 'read-only'],
    ['<select id="field"><option>old</option></select>', 'not editable'],
    ['<div id="field">old</div>', 'not editable'],
    ['<svg id="field"></svg>', 'unsupported element'],
  ])('rejects a noneditable target: %s', async (html, message) => {
    document.body.innerHTML = html
    const before = document.body.innerHTML
    const input = vi.fn()
    document.body.addEventListener('input', input, { once: true })

    expectError(await fill('#field', 'new'), message)

    expect(document.body.innerHTML).toBe(before)
    expect(input).not.toHaveBeenCalled()
    document.body.removeEventListener('input', input)
  })

  it.each(['checkbox', 'radio', 'file', 'hidden', 'number', 'date', 'range', 'color', 'submit'])(
    'rejects unsupported input type %s without claiming success or firing input',
    async (type) => {
      document.body.innerHTML = `<input id="field" type="${type}">`
      const field = document.querySelector<HTMLInputElement>('#field')!
      const before = field.value
      const input = vi.fn()
      field.addEventListener('input', input)

      expectError(await fill('#field', 'new'), `unsupported input type ${type}`)

      expect(field.value).toBe(before)
      expect(input).not.toHaveBeenCalled()
    },
  )

  it('reports missing and invalid selectors and rejects invalid text arguments', async () => {
    expectError(await fill('#missing', 'new'), 'no element for #missing')
    expectError(await fill('[', 'new'), 'valid selector')
    expectError(await fill('', 'new'), 'selector is required')
    document.body.innerHTML = '<textarea id="field">old</textarea>'
    for (const text of [undefined, null, 42, {}]) {
      expectError(await fill('#field', text), 'text must be a string')
    }
    expect(document.querySelector<HTMLTextAreaElement>('#field')?.value).toBe('old')
  })

  it('reports text rejected by a native field without leaving a partial edit or firing input', async () => {
    document.body.innerHTML = '<input id="field" value="old">'
    const field = document.querySelector<HTMLInputElement>('#field')!
    const input = vi.fn()
    field.addEventListener('input', input)

    expectError(await fill('#field', 'new\nline'), 'rejected the text')

    expect(field.value).toBe('old')
    expect(input).not.toHaveBeenCalled()
  })

  it('reports a guest script failure', async () => {
    const browser = service()
    vi.mocked(browser.runScript).mockRejectedValue(new Error('guest destroyed'))
    expectError(
      await dispatchBrowserMcpTool(browser, 'browser_type', { selector: '#field', text: 'new' }),
      'guest destroyed',
    )
  })
})
