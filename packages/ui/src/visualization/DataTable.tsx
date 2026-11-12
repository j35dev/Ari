import { useMemo, useState } from 'react'
import type { VisualizationSpec } from '@ari/contracts/visualization'
import { visualizationData } from './data'
import { InteractiveSurface, pointDetail } from './interaction'

/** Quoting preserves multiline cells; string formula prefixes stay text when pasted into a sheet. */
export function dataCsv(columns: string[], rows: (string | number)[][]): string {
  const cell = (value: string | number): string => {
    const text =
      typeof value === 'string' && /^\s*[=+\-@]/.test(value) ? `'${value}` : String(value)
    return `"${text.replace(/"/g, '""')}"`
  }
  return [columns, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')
}

export function DataTable({ spec }: { spec: VisualizationSpec }) {
  const data = useMemo(() => visualizationData(spec), [spec])
  const [query, setQuery] = useState('')
  const [copyState, setCopyState] = useState('')
  const search = query.trim().toLocaleLowerCase()
  const rows = useMemo(
    () =>
      search
        ? data.rows.filter((row) =>
            row.some((value) => String(value).toLocaleLowerCase().includes(search)),
          )
        : data.rows,
    [data, search],
  )
  // A short comparison is read at a glance; filtering it would be chrome for its own sake.
  const tools = spec.type !== 'comparison' || data.rows.length > 8
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(dataCsv(data.columns, rows))
      setCopyState('Copied')
    } catch {
      setCopyState('Copy unavailable')
    }
  }
  return (
    <InteractiveSurface resetKey={query}>
      <div className="ari-viz-data-view">
        <div className="ari-viz-data-toolbar" hidden={!tools}>
          <label className="ari-viz-data-search">
            <span className="ari-viz-sr-only">Filter visualization data</span>
            <input
              type="search"
              placeholder="Filter data…"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setCopyState('')
              }}
            />
          </label>
          <span className="ari-viz-row-count">
            {rows.length} of {data.rows.length} rows
          </span>
          <button
            type="button"
            className="ari-viz-action"
            aria-label="Copy table as CSV"
            onClick={() => {
              void copy()
            }}
          >
            {copyState || 'Copy CSV'}
          </button>
        </div>
        <div
          className="ari-viz-scroll ari-viz-table-scroll"
          tabIndex={0}
          role="region"
          aria-label={`${spec.title} data table`}
        >
          <table className="ari-viz-table">
            <caption className="ari-viz-sr-only">{spec.title} — data</caption>
            <thead>
              <tr>
                {data.columns.map((column, i) => (
                  <th scope="col" key={i}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) =>
                    j === 0 ? (
                      <th scope="row" key={j}>
                        {cell}
                      </th>
                    ) : (
                      <td
                        key={j}
                        className="ari-viz-mark"
                        tabIndex={0}
                        data-viz-detail={pointDetail({
                          title: `${row[0] ?? ''} · ${data.columns[j] ?? ''}`,
                          rows: [{ label: data.columns[j] ?? 'Value', value: cell }],
                        })}
                      >
                        {cell}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && <p className="ari-viz-data-empty">No rows match “{query}”.</p>}
        </div>
      </div>
    </InteractiveSurface>
  )
}
