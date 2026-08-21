// @vitest-environment jsdom
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { createElement, useEffect } from 'react'

describe('effect timing', () => {
  it('runs effects by the time render returns', () => {
    const state = { ran: false }
    function Probe() {
      useEffect(() => {
        state.ran = true
      }, [])
      return createElement('div')
    }
    render(createElement(Probe))
    expect(state.ran).toBe(true)
  })
})
