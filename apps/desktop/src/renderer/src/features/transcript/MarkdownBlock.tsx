import { memo, useLayoutEffect, useRef } from 'react'
import { createCodeStream, type CodeStream } from './code-stream'
import { highlightCode, highlightCodeSync, shikiInner } from './highlight'
import { createMarkdownStream, type MarkdownStream } from './markdown-stream'
import { morphNode } from './morph-dom'

/**
 * Longest code block re-highlighted on every flush. Past this a flush would
 * spend longer tokenizing than the frame it has, so the block waits until the
 * text stops moving.
 */
const LIVE_HIGHLIGHT_MAX_CHARS = 20_000
const SETTLE_HIGHLIGHT_MS = 300

const settleTimers = new WeakMap<Element, ReturnType<typeof setTimeout>>()
const codeStreams = new WeakMap<Element, CodeStream>()

function codeElements(node: Node): HTMLElement[] {
  if (!(node instanceof Element)) return []
  return Array.from(node.querySelectorAll<HTMLElement>('pre code[class*="language-"]'))
}

function languageOf(code: Element): string | null {
  return /(?:^|\s)language-([\w#+.-]+)/.exec(code.className)?.[1] ?? null
}

function paint(code: HTMLElement, html: string): void {
  code.innerHTML = shikiInner(html)
  code.dataset['highlighted'] = ''
}

/** Colors what can be colored before the block reaches the document. */
function highlightNow(block: Node, compute: boolean): void {
  for (const code of codeElements(block)) {
    const lang = languageOf(code)
    const source = code.textContent ?? ''
    if (lang === null || source.length > LIVE_HIGHLIGHT_MAX_CHARS) continue
    const html = highlightCodeSync(source, lang, compute)
    if (html !== null) paint(code, html)
  }
}

/**
 * Colors the rest once the highlighter answers, unless the code moved on. An
 * oversized block that is still being written waits for the text to settle;
 * everything else asks at once, which also warms the language so the next
 * flush can be colored in its own frame.
 */
function highlightLater(block: Node, live: boolean): void {
  for (const code of codeElements(block)) {
    const lang = languageOf(code)
    if (lang === null || 'highlighted' in code.dataset) continue
    clearTimeout(settleTimers.get(code))
    const run = (): void => {
      const source = code.textContent ?? ''
      void highlightCode(source, lang).then((html) => {
        if (html === null || !code.isConnected || code.textContent !== source) return
        paint(code, html)
      })
    }
    const oversized = (code.textContent ?? '').length > LIVE_HIGHLIGHT_MAX_CHARS
    if (live && oversized) settleTimers.set(code, setTimeout(run, SETTLE_HIGHLIGHT_MS))
    else run()
  }
}

/** The `<code>` of a top-level fenced block — the shape long streamed code takes. */
function fencedCode(block: Node): HTMLElement | null {
  if (!(block instanceof HTMLPreElement) || block.childNodes.length !== 1) return null
  const code = block.firstElementChild
  return code instanceof HTMLElement && code.tagName === 'CODE' ? code : null
}

/**
 * Grows a fenced block that is being written by its new lines alone (see
 * `createCodeStream`), leaving every finished line's elements in place. False
 * when the block is not that shape or cannot be highlighted yet, and the
 * caller falls back to morphing it whole.
 */
function streamFence(current: Node, fresh: Node): boolean {
  const live = fencedCode(current)
  const next = fencedCode(fresh)
  if (live === null || next === null || live.className !== next.className) return false
  const lang = languageOf(next)
  if (lang === null) return false
  const stream = codeStreams.get(live) ?? createCodeStream(lang)
  const patch = stream.advance(next.textContent ?? '')
  if (patch === null) {
    codeStreams.delete(live)
    return false
  }
  codeStreams.set(live, stream)
  clearTimeout(settleTimers.get(live))
  while (live.childNodes.length > patch.keep * 2) live.lastChild?.remove()
  live.insertAdjacentHTML('beforeend', patch.html)
  live.dataset['highlighted'] = ''
  return true
}

/** The single node a block's HTML describes. */
function parseBlock(html: string): Node {
  const template = document.createElement('template')
  template.innerHTML = html
  return template.content.firstChild ?? document.createTextNode('')
}

/**
 * Renders one markdown text block as a column of top-level elements that this
 * component, not React, keeps in step with `text`.
 *
 * A streaming reply re-renders this block on every flush. Setting its markup
 * wholesale rebuilt every paragraph and reset every highlighted code block to
 * plain text each time, which is what made a long reply flicker as it grew.
 * Here a flush re-parses only the block still being written (see
 * `createMarkdownStream`) and morphs that one element in place: finished
 * blocks are never touched, and code keeps its colors as lines are appended.
 *
 * `streaming` marks the reply a running turn is writing; blocks that arrive
 * while it is set fade in (transcript.css).
 *
 * Memoized on its props: every settled block above the live one skips the
 * pipeline entirely.
 */
export const MarkdownBlock = memo(function MarkdownBlock({
  text,
  streaming = false,
}: {
  text: string
  streaming?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const streamRef = useRef<MarkdownStream | null>(null)
  const shownRef = useRef<string[]>([])

  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    streamRef.current ??= createMarkdownStream()
    const next = streamRef.current.render(text)
    const shown = shownRef.current
    // The first paint of a block stays plain and colors afterwards, as opening
    // a long session must not tokenize every code block before it shows. Any
    // later change is a live edit and is colored in the same frame.
    const live = shown.length > 0

    next.forEach((html, index) => {
      const current = root.childNodes[index]
      if (current !== undefined && shown[index] === html) return
      const fresh = parseBlock(html)
      if (live && current !== undefined && streamFence(current, fresh)) return
      highlightNow(fresh, live)
      if (current === undefined) root.appendChild(fresh)
      else if (!morphNode(current, fresh)) root.replaceChild(fresh, current)
      const placed = root.childNodes[index]
      if (placed !== undefined) highlightLater(placed, live)
    })
    while (root.childNodes.length > next.length) root.lastChild?.remove()
    shownRef.current = next
  }, [text])

  return <div ref={ref} className="ari-md" data-streaming={streaming ? '' : undefined} />
})
