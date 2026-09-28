import type { PickedElement } from '@ari/contracts/rpc'

const TEXT_CAP = 400
const HTML_CAP = 1_500

export function formatElementContext(element: PickedElement): string {
  const lines = [
    `Selected element on ${element.url}`,
    `- tag: ${element.tag}`,
    `- selector: ${element.selector}`,
  ]
  if (element.role) lines.push(`- role: ${element.role}`)
  if (element.ariaLabel) lines.push(`- aria-label: ${element.ariaLabel}`)
  if (element.text) lines.push(`- text: ${element.text.slice(0, TEXT_CAP)}`)
  if (element.html) lines.push(`- html: ${element.html.slice(0, HTML_CAP)}`)
  return lines.join('\n')
}

export function formatElementContexts(elements: readonly PickedElement[]): string {
  if (elements.length === 0) return ''
  const body = elements
    .map((el, i) => `Element ${String(i + 1)}\n${formatElementContext(el)}`)
    .join('\n\n')
  return `<element_context>\n${body}\n</element_context>`
}

export function elementChipLabel(element: PickedElement): string {
  const text = element.text.trim().replace(/\s+/g, ' ')
  if (text.length > 0) return text.length > 32 ? `${text.slice(0, 31)}…` : text
  if (element.ariaLabel) return element.ariaLabel
  return element.selector
}
