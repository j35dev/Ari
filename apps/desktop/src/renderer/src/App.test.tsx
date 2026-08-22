import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { useToast } from '@ari/ui/toast'
import { AppProviders } from './App'

function ToastProbe() {
  const { toast } = useToast()
  return (
    <button type="button" onClick={() => toast({ title: 'Ready', tone: 'info' })}>
      ping toast
    </button>
  )
}

describe('AppProviders', () => {
  it('lets useToast consumers fire without a wrapping gallery', async () => {
    const user = userEvent.setup()
    render(
      <AppProviders>
        <ToastProbe />
      </AppProviders>,
    )

    await user.click(screen.getByRole('button', { name: 'ping toast' }))
    expect(await screen.findByText('Ready')).toBeInTheDocument()
  })
})
