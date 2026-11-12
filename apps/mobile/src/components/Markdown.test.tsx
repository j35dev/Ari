// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Markdown } from './Markdown'

afterEach(cleanup)

const source =
  '{"version":1,"type":"metrics","title":"Progress","items":[{"label":"Done","value":4}]}'
describe('mobile reply visuals', () => {
  it('uses the shared renderer between ordinary reply paragraphs', () => {
    const { container } = render(
      <Markdown text={`Before\n\n\`\`\`ari-viz\n${source}\n\`\`\`\n\nAfter`} />,
    )
    expect(screen.getByRole('figure', { name: 'Progress' })).toBeInTheDocument()
    expect(container.firstElementChild?.firstElementChild).toHaveTextContent('Before')
    expect(container.firstElementChild?.lastElementChild).toHaveTextContent('After')
    fireEvent.click(screen.getByRole('button', { name: 'Show data table' }))
    expect(screen.getByRole('table')).toHaveTextContent('Done4')
  })
  it('shows incomplete visuals as pending only while the turn is running', () => {
    const { rerender } = render(<Markdown text={'```ari-viz\n{bad'} streaming />)
    expect(screen.getByRole('status')).toHaveTextContent('Building visualization')
    rerender(<Markdown text={'```ari-viz\n{bad'} />)
    expect(screen.getByText('Visualization unavailable')).toBeInTheDocument()
  })

  // Conversation sends every mobile text part, user or assistant, through Markdown.
  it('renders one wrapped timeline beside a flat chart', () => {
    const wrapped =
      '{"version":1,"type":"timeline","title":"Release progress","data":{"events":[{"label":"v0.2.0","date":"2026-08-30","description":"Previous release"},{"label":"v0.3.13","date":"in progress","tone":"warning"}]}}'
    const text = [
      'Before',
      '',
      '```ari-viz',
      source,
      '```',
      '',
      '```ari-viz',
      wrapped,
      '```',
      '',
      'After',
    ].join('\n')
    render(<Markdown text={text} />)
    expect(screen.getByRole('figure', { name: 'Progress' })).toBeInTheDocument()
    expect(screen.getByText('v0.2.0').closest('li')?.getAttribute('style')).toContain(
      'var(--ari-accent)',
    )
    expect(screen.getByText('v0.3.13').closest('li')?.getAttribute('style')).toContain(
      'var(--ari-warning)',
    )
    expect(document.querySelector('code.language-ari-viz')).toBeNull()
  })

  it('names the missing field and does not echo markup from an extra key', () => {
    const { rerender } = render(
      <Markdown
        text={'```ari-viz\n{"version":1,"type":"timeline","title":"Missing events"}\n```'}
      />,
    )
    expect(screen.getByText('Timeline charts need events.')).toBeInTheDocument()
    expect(screen.queryByText('Invalid input')).toBeNull()
    rerender(
      <Markdown
        text={
          '```ari-viz\n{"version":1,"type":"timeline","title":"Marked up","events":[{"label":"A"}],"html":"<script>alert(1)</script>"}\n```'
        }
      />,
    )
    expect(screen.getByText('Timeline charts cannot include "html".')).toBeInTheDocument()
    expect(screen.queryByText(/alert\(1\)/)).toBeNull()
    expect(document.querySelector('script')).toBeNull()
  })
})
