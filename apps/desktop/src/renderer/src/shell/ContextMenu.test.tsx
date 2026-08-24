import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { Trash2 } from 'lucide-react'
import { ContextMenu, useContextMenu } from './ContextMenu'

function Harness({ onPick }: { onPick: (id: string) => void }) {
  const menu = useContextMenu()
  return (
    <div>
      <button type="button" onContextMenu={(e) => menu.open('row', e)}>
        Row
      </button>
      {menu.openFor === 'row' ? (
        <ContextMenu
          anchor={menu.anchor}
          label="Row actions"
          onClose={menu.close}
          items={[
            { id: 'rename', label: 'Rename', onSelect: () => onPick('rename') },
            { id: 'delete', label: 'Delete', icon: Trash2, danger: true, onSelect: () => onPick('delete') },
          ]}
        />
      ) : null}
    </div>
  )
}

describe('ContextMenu', () => {
  it('opens on right-click and runs the chosen action', async () => {
    const onPick = vi.fn()
    const user = userEvent.setup()
    render(<Harness onPick={onPick} />)

    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button', { name: 'Row' }) })

    const menu = screen.getByRole('menu', { name: 'Row actions' })
    await user.click(within(menu).getByRole('menuitem', { name: 'Delete' }))
    expect(onPick).toHaveBeenCalledWith('delete')
    // Closing before the action runs keeps the menu from outliving its row.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('closes on Escape without running anything', async () => {
    const onPick = vi.fn()
    const user = userEvent.setup()
    render(<Harness onPick={onPick} />)
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button', { name: 'Row' }) })

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(onPick).not.toHaveBeenCalled()
  })

  it('moves focus with the arrow keys', async () => {
    const user = userEvent.setup()
    render(<Harness onPick={() => undefined} />)
    await user.pointer({ keys: '[MouseRight]', target: screen.getByRole('button', { name: 'Row' }) })

    // First item is focused on open.
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveFocus()
    await user.keyboard('{ArrowDown}')
    expect(screen.getByRole('menuitem', { name: 'Rename' })).toHaveFocus()
  })

  it('keeps the menu inside the viewport', async () => {
    const user = userEvent.setup()
    render(<Harness onPick={() => undefined} />)
    const row = screen.getByRole('button', { name: 'Row' })
    // jsdom reports 0×0 rects, so a right-click lands at 0,0 — the clamp must
    // still produce a positive, in-bounds position rather than a negative one.
    await user.pointer({ keys: '[MouseRight]', target: row })

    const menu = screen.getByRole('menu', { name: 'Row actions' })
    expect(Number.parseInt(menu.style.left, 10)).toBeGreaterThanOrEqual(0)
    expect(Number.parseInt(menu.style.top, 10)).toBeGreaterThanOrEqual(0)
  })
})
