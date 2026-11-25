import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveLocalHtml } from './local-html'

const base = resolve('/work/site')

describe('resolveLocalHtml', () => {
  it('resolves a relative path against the session folder', () => {
    expect(resolveLocalHtml('out/report.html', base)).toBe(resolve(base, 'out/report.html'))
    expect(resolveLocalHtml('./index.htm', base)).toBe(resolve(base, 'index.htm'))
  })

  it('keeps an absolute path and reads a file URL', () => {
    const absolute = resolve('/tmp/My Report.html')
    expect(resolveLocalHtml(absolute, base)).toBe(absolute)
    expect(resolveLocalHtml(pathToFileURL(absolute).href, null)).toBe(absolute)
  })

  it('decodes a markdown link target and drops its fragment', () => {
    expect(resolveLocalHtml('out/My%20Report.html#totals', base)).toBe(
      resolve(base, 'out/My Report.html'),
    )
  })

  it('refuses anything that is not an HTML file', () => {
    expect(() => resolveLocalHtml('tools/setup.exe', base)).toThrow('Only HTML files')
    expect(() => resolveLocalHtml('page.html.exe', base)).toThrow('Only HTML files')
    expect(() => resolveLocalHtml('file:///C:/Windows/System32/cmd.exe', base)).toThrow(
      'Only HTML files',
    )
  })

  it('refuses network paths, which would send the login hash to another machine', () => {
    for (const target of [
      '\\\\attacker\\share\\page.html',
      '//attacker/share/page.html',
      '\\\\?\\UNC\\attacker\\share\\page.html',
      '%5C%5Cattacker%5Cshare%5Cpage.html',
      'file://attacker/share/page.html',
      'file:////attacker/share/page.html',
    ])
      expect(() => resolveLocalHtml(target, base), target).toThrow()
  })

  it('refuses a relative path with no folder to resolve it in', () => {
    expect(() => resolveLocalHtml('out/report.html', null)).toThrow("Can't tell which folder")
  })
})
