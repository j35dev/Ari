import { act, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { setReducedMotion, useReducedMotionSetting } from './reduced-motion'

function Probe() {
  return <output data-testid="reduced">{String(useReducedMotionSetting())}</output>
}

describe('reduced motion setting', () => {
  afterEach(() => setReducedMotion(false))

  it('marks <html> so the stylesheet can still every animation', () => {
    setReducedMotion(true)
    expect(document.documentElement.dataset['ariReduceMotion']).toBe('')
    setReducedMotion(false)
    expect('ariReduceMotion' in document.documentElement.dataset).toBe(false)
  })

  it('re-renders subscribers when the switch flips', () => {
    render(<Probe />)
    expect(screen.getByTestId('reduced')).toHaveTextContent('false')
    act(() => setReducedMotion(true))
    expect(screen.getByTestId('reduced')).toHaveTextContent('true')
  })
})
