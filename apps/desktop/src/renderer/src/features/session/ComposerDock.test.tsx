import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createRef } from 'react'
import { ComposerDock } from './ComposerDock'

afterEach(() => vi.restoreAllMocks())

it('measures the parent after mount and retargets without replacing the focused editor', async () => {
  const canvasRef = createRef<HTMLDivElement>()
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(600)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(100)
  const onStart = vi.fn()
  const view = (centered: boolean) => (
    <div ref={canvasRef}>
      <ComposerDock centered={centered} canvasRef={canvasRef} reducedMotion onStart={onStart}>
        <textarea aria-label="Draft" defaultValue="Keep my draft" />
      </ComposerDock>
    </div>
  )
  const { rerender } = render(view(true))
  const editor = screen.getByLabelText('Draft')
  const dock = editor.closest('.ari-composer-dock')
  await waitFor(() => expect(dock).toHaveStyle({ transform: 'translateY(-238px)' }))
  fireEvent.click(screen.getByRole('button', { name: 'Build something' }))
  expect(onStart).toHaveBeenCalledWith('Help me plan and build a new feature in this project.')
  editor.focus()
  ;(editor as HTMLTextAreaElement).setSelectionRange(3, 8)
  rerender(view(false))
  await waitFor(() => expect(dock).toHaveStyle({ transform: 'none' }))
  expect(screen.getByLabelText('Draft')).toBe(editor)
  expect(editor).toHaveFocus()
  expect(editor).toHaveValue('Keep my draft')
  expect((editor as HTMLTextAreaElement).selectionStart).toBe(3)
  expect(screen.queryByRole('button', { name: 'Build something' })).not.toBeInTheDocument()
})
