import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ThemeProvider } from '@ari/ui/theme-provider'
import type { ThemeId } from '@ari/ui/theme-provider'
import { buildAppCommands, nextThemeId, useAppCommands } from './useCommands'

const ctx = {
  onNavigate: vi.fn(),
  onOpenGallery: vi.fn(),
  theme: 'obsidian' as ThemeId,
  setTheme: vi.fn(),
}

describe('buildAppCommands', () => {
  it('returns at least six commands with unique ids', () => {
    const commands = buildAppCommands(ctx)
    expect(commands.length).toBeGreaterThanOrEqual(6)
    expect(new Set(commands.map((c) => c.id)).size).toBe(commands.length)
  })

  it('wires each navigation command to its rail view', () => {
    const commands = buildAppCommands(ctx)
    for (const view of ['sessions', 'projects', 'terminal', 'changes', 'settings'] as const) {
      ctx.onNavigate.mockClear()
      commands.find((c) => c.id === `nav.${view}`)!.run()
      expect(ctx.onNavigate).toHaveBeenCalledWith(view)
    }
  })

  it('opens the gallery', () => {
    buildAppCommands(ctx)
      .find((c) => c.id === 'view.gallery')!
      .run()
    expect(ctx.onOpenGallery).toHaveBeenCalledOnce()
  })

  it('cycles the theme forward and labels the target theme', () => {
    const commands = buildAppCommands(ctx)
    const cycle = commands.find((c) => c.id === 'theme.cycle')!
    expect(cycle.label).toContain('Graphite')
    cycle.run()
    expect(ctx.setTheme).toHaveBeenCalledWith('graphite')
  })
})

describe('nextThemeId', () => {
  it('wraps around at the end of the theme list', () => {
    expect(nextThemeId('obsidian')).toBe('graphite')
    expect(nextThemeId('ultraviolet')).toBe('obsidian')
  })
})

describe('useAppCommands', () => {
  it('builds the command list inside a ThemeProvider', () => {
    const { result } = renderHook(
      () => useAppCommands({ onNavigate: vi.fn(), onOpenGallery: vi.fn() }),
      { wrapper: ThemeProvider },
    )
    expect(result.current.length).toBeGreaterThanOrEqual(6)
    const cycle = result.current.find((c) => c.id === 'theme.cycle')
    expect(cycle).toBeDefined()
    act(() => cycle!.run())
  })
})
