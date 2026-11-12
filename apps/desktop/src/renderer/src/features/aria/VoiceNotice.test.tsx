import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { VoiceNotice } from './VoiceNotice'

it('keeps the speech error readable with a named dismissal control', () => {
  const dismiss = vi.fn()
  render(<VoiceNotice message="Kokoro’s English voice cannot read this language. Choose Groq in speech output settings." onDismiss={dismiss} />)
  expect(screen.getByRole('alert')).toHaveTextContent('Voice needs attention')
  expect(screen.getByRole('alert')).toHaveTextContent('Choose Groq')
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss voice notice' }))
  expect(dismiss).toHaveBeenCalledOnce()
})
