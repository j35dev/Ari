import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Field } from './Field'

describe('Field', () => {
  it('associates the label with the control id', () => {
    render(
      <Field label="API key">{(p) => <input data-testid="ctl" {...p} />}</Field>,
    )
    const ctl = screen.getByTestId('ctl')
    expect(screen.getByLabelText('API key')).toBe(ctl)
    expect(ctl.id).not.toBe('')
  })

  it('keeps a stable id across rerenders', () => {
    const { rerender } = render(
      <Field label="Name">{(p) => <input data-testid="ctl" {...p} />}</Field>,
    )
    const before = screen.getByTestId('ctl').id
    rerender(
      <Field label="Name">{(p) => <input data-testid="ctl" {...p} />}</Field>,
    )
    expect(screen.getByTestId('ctl').id).toBe(before)
  })

  it('error sets aria-invalid and wires describedby to the error element', () => {
    render(
      <Field label="Port" error="Must be a number">
        {(p) => <input data-testid="ctl" {...p} />}
      </Field>,
    )
    const ctl = screen.getByTestId('ctl')
    expect(ctl.getAttribute('aria-invalid')).toBe('true')
    const errorEl = screen.getByText('Must be a number')
    expect(ctl.getAttribute('aria-describedby')).toBe(errorEl.id)
  })

  it('joins hint and error ids into aria-describedby', () => {
    render(
      <Field label="Token" hint="Stored locally" error="Required">
        {(p) => <input data-testid="ctl" {...p} />}
      </Field>,
    )
    const ctl = screen.getByTestId('ctl')
    const hint = screen.getByText('Stored locally')
    const error = screen.getByText('Required')
    expect(ctl.getAttribute('aria-describedby')).toBe(`${hint.id} ${error.id}`)
  })

  it('omits aria-describedby when there is no hint or error', () => {
    render(
      <Field label="Name">{(p) => <input data-testid="ctl" {...p} />}</Field>,
    )
    expect(screen.getByTestId('ctl').getAttribute('aria-describedby')).toBeNull()
    expect(screen.getByTestId('ctl').getAttribute('aria-invalid')).toBeNull()
  })
})
