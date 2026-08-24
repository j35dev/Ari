import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { buildAppCommands, useCommands } from './useCommands'

const ctx = {
  onNavigate: vi.fn(),
  onOpenGallery: vi.fn(),
  onOpenSearch: vi.fn(),
  onOpenRace: vi.fn(),
}

describe('buildAppCommands', () => {
  it('returns at least six commands with unique ids', () => {
    const commands = buildAppCommands(ctx)
    expect(commands.length).toBeGreaterThanOrEqual(6)
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length)
  })

  it('wires each navigation command to its rail view', () => {
    const commands = buildAppCommands(ctx)
    for (const view of [
      'sessions',
      'terminal',
      'changes',
      'settings',
      'files',
      'usage',
    ] as const) {
      ctx.onNavigate.mockClear()
      commands.find((c) => c.id === `nav.${view}`)!.run()
      expect(ctx.onNavigate).toHaveBeenCalledWith(view)
    }
  })

  it('no longer offers Projects as a navigation destination', () => {
    // Projects live in the sidebar itself (M16); the rail entry is gone.
    expect(buildAppCommands(ctx).find((c) => c.id === 'nav.projects')).toBeUndefined()
  })

  it('opens the gallery', () => {
    buildAppCommands(ctx)
      .find((c) => c.id === 'view.gallery')!
      .run()
    expect(ctx.onOpenGallery).toHaveBeenCalledOnce()
  })

  it('opens project content search with the keyboard hint', () => {
    const search = buildAppCommands(ctx).find((c) => c.id === 'search.project')!
    expect(search.hint).toBe('Ctrl+Shift+F')
    search.run()
    expect(ctx.onOpenSearch).toHaveBeenCalledOnce()
  })
})

describe('useCommands', () => {
  it('memoizes the command list per context', () => {
    const { result, rerender } = renderHook(() => useCommands(ctx))
    const first = result.current
    rerender()
    expect(result.current).toBe(first)
  })
})
