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
    fireEvent.click(screen.getByRole('button', { name: 'Data' }))
    expect(screen.getByRole('table')).toHaveTextContent('Done4')
  })
  it('shows incomplete visuals as pending only while the turn is running', () => {
    const { rerender } = render(<Markdown text={'```ari-viz\n{bad'} streaming />)
    expect(screen.getByRole('status')).toHaveTextContent('Building visualization')
    rerender(<Markdown text={'```ari-viz\n{bad'} />)
    expect(screen.getByText('Visualization unavailable')).toBeInTheDocument()
  })
})
