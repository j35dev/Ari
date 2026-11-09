import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Visualization } from './Visualization'
import { visualizationExamples } from './examples'
import { dataCsv } from './DataTable'

describe('visualization data view', () => {
  it('filters rows, preserves table headers and copies the displayed data', async () => {
    const copy = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText: copy } })
    try {
      render(<Visualization source={JSON.stringify(visualizationExamples[0]?.spec)} />)
      fireEvent.click(screen.getByRole('button', { name: 'Data' }))
      fireEvent.change(screen.getByRole('searchbox', { name: 'Filter visualization data' }), {
        target: { value: 'report' },
      })
      expect(screen.getByText('1 of 4 rows')).toBeInTheDocument()
      expect(screen.getByRole('table')).toHaveTextContent('Reporting')
      expect(screen.getByRole('table')).not.toHaveTextContent('Research')
      fireEvent.click(screen.getByRole('button', { name: 'Copy table as CSV' }))
      await vi.waitFor(() =>
        expect(copy).toHaveBeenCalledWith('"Label","Before","After"\r\n"Reporting","8","2"'),
      )
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
      expect(screen.getByText('No rows match “missing”.')).toBeInTheDocument()
      expect(screen.getAllByRole('row')).toHaveLength(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('preserves quoted and multiline cells and keeps formula-like strings as text', () => {
    expect(
      dataCsv(
        ['Name', 'Value'],
        [
          ['a,"b"', 'line\nnext'],
          ['=SUM(A1)', -2],
        ],
      ),
    ).toBe('"Name","Value"\r\n"a,""b""","line\nnext"\r\n"\'=SUM(A1)","-2"')
  })
})
