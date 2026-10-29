import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import type { BotCharacter } from '@ari/contracts/bot'
import { BotLookEditor } from './BotLookEditor'

function Harness({ start, random }: { start: BotCharacter; random?: () => number }) {
  const [look, setLook] = useState(start)
  return <BotLookEditor value={look} onChange={setLook} previewLabel="Forge" random={random} />
}

function preview(): SVGElement {
  return screen.getByRole('img', { name: 'Forge preview' }) as unknown as SVGElement
}

describe('BotLookEditor', () => {
  it('previews the look and marks the chosen shape and colour', () => {
    render(<Harness start={{ shape: 'pill', palette: 2 }} />)

    expect(preview()).toHaveAttribute('data-shape', 'pill')
    expect(preview()).toHaveAttribute('data-palette', '2')
    expect(preview()).toHaveAttribute('data-mood', 'idle')
    expect(screen.getByRole('radio', { name: 'Pill' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('radio', { name: 'Sage' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getAllByRole('radio')).toHaveLength(16)
  })

  it('changes the preview from the shape and colour pickers', async () => {
    render(<Harness start={{ shape: 'drop', palette: 0 }} />)

    await userEvent.click(screen.getByRole('radio', { name: 'Cloud' }))
    expect(preview()).toHaveAttribute('data-shape', 'cloud')
    await userEvent.click(screen.getByRole('radio', { name: 'Mint' }))
    expect(preview()).toHaveAttribute('data-palette', '9')
    expect(screen.getByRole('radio', { name: 'Slate' })).toHaveAttribute('aria-checked', 'false')
  })

  it('moves through a group with the arrow keys and keeps one tab stop', async () => {
    render(<Harness start={{ shape: 'drop', palette: 0 }} />)
    const shapes = screen.getByRole('radiogroup', { name: 'Shape' })
    const drop = screen.getByRole('radio', { name: 'Drop' })

    expect(drop).toHaveAttribute('tabindex', '0')
    expect(screen.getByRole('radio', { name: 'Cloud' })).toHaveAttribute('tabindex', '-1')

    drop.focus()
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'Cloud' })).toHaveFocus()
    expect(preview()).toHaveAttribute('data-shape', 'cloud')

    await userEvent.keyboard('{End}')
    expect(preview()).toHaveAttribute('data-shape', 'pebble')
    await userEvent.keyboard('{ArrowRight}')
    expect(preview()).toHaveAttribute('data-shape', 'drop')
    await userEvent.keyboard('{ArrowLeft}')
    expect(preview()).toHaveAttribute('data-shape', 'pebble')
    expect(shapes).toContainElement(document.activeElement as HTMLElement)
  })

  it('shuffles to a different look', async () => {
    // The first roll repeats the current look; Shuffle must not settle on it.
    const rolls = [0, 0, 0.5, 0.5]
    render(<Harness start={{ shape: 'drop', palette: 0 }} random={() => rolls.shift() ?? 0} />)

    await userEvent.click(screen.getByRole('button', { name: 'Shuffle' }))
    expect(preview()).toHaveAttribute('data-shape', 'wisp')
    expect(preview()).toHaveAttribute('data-palette', '5')
  })
})
