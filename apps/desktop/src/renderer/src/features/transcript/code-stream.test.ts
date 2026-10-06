import { beforeAll, describe, expect, it } from 'vitest'
import { createCodeStream, type CodePatch } from './code-stream'
import { highlightCode, shikiInner } from './highlight'

const SOURCE = [
  'const greeting = `hello',
  '  ${name}, this template',
  '  spans lines`',
  '/* a comment',
  '   that also spans */',
  'export function add(a: number, b: number): number {',
  '  return a + b',
  '}',
  '',
].join('\n')

/** Applies a patch the way the transcript does. */
function apply(code: HTMLElement, patch: CodePatch): void {
  while (code.childNodes.length > patch.keep * 2) code.lastChild?.remove()
  code.insertAdjacentHTML('beforeend', patch.html)
}

/** What one pass over `source` renders, with the trailing empty line it adds dropped. */
async function whole(source: string): Promise<string> {
  const html = await highlightCode(source, 'ts')
  if (html === null) throw new Error('highlighter unavailable')
  const code = document.createElement('code')
  code.innerHTML = shikiInner(html)
  if (source.endsWith('\n')) code.lastChild?.remove()
  return code.innerHTML
}

describe('createCodeStream', () => {
  beforeAll(async () => {
    await highlightCode('warm', 'ts')
  })

  it('waits for a language the highlighter does not hold yet', () => {
    expect(createCodeStream('rust').advance('fn main() {}')).toBeNull()
  })

  it('matches one pass over the source at every point of a stream', async () => {
    const stream = createCodeStream('ts')
    const code = document.createElement('code')
    // Uneven chunks, so cuts land mid-line, mid-template and mid-comment.
    for (let end = 1; end < SOURCE.length; end += 5) {
      // The renderer always ends code with a newline while it streams.
      const source = `${SOURCE.slice(0, end)}\n`
      const patch = stream.advance(source)
      if (patch === null) throw new Error('stream refused a warm language')
      apply(code, patch)
      expect(code.textContent).toBe(source)
      expect(code.innerHTML).toBe(await whole(source))
    }
  })

  it('keeps every finished line and highlights only what follows', () => {
    const stream = createCodeStream('ts')
    stream.advance('const a = 1\nconst b = 2\nconst c\n')
    const patch = stream.advance('const a = 1\nconst b = 2\nconst c = 3\nconst d\n')

    expect(patch?.keep).toBe(2)
    expect(patch?.html).toContain('c')
    expect(patch?.html).not.toContain('>a<')
  })

  it('starts over when the code is replaced rather than appended to', () => {
    const stream = createCodeStream('ts')
    stream.advance('const a = 1\nconst b = 2\n')
    expect(stream.advance('let z\n')?.keep).toBe(0)
  })
})
