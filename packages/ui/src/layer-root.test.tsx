import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Dialog } from './components/Dialog'
import { ToastProvider } from './components/Toast'
import { LAYER_ROOT_ID, layerRoot } from './layer-root'

describe('layerRoot', () => {
  afterEach(() => {
    document.getElementById(LAYER_ROOT_ID)?.remove()
  })

  it('falls back to the body on a page without a layer root', () => {
    expect(layerRoot()).toBe(document.body)
  })

  it('carries scrims and toasts outside the app root once the page has one', () => {
    const root = document.createElement('div')
    root.id = LAYER_ROOT_ID
    document.body.append(root)
    const { container } = render(
      <ToastProvider>
        <Dialog open onOpenChange={() => undefined}>
          <Dialog.Content>
            <Dialog.Title>Confirm</Dialog.Title>
          </Dialog.Content>
        </Dialog>
      </ToastProvider>,
    )
    const dialog = screen.getByRole('dialog')
    expect(root).toContainElement(dialog)
    expect(dialog.parentElement).toHaveClass('z-overlay')
    const toasts = root.querySelector('[data-toast-viewport]')
    expect(toasts).toHaveClass('z-toast')
    expect(container).not.toContainElement(dialog)
  })
})
