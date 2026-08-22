import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  SETTINGS_SEARCH_INDEX,
  SettingsSearch,
  filterSettingsIndex,
} from './SettingsSearch'

describe('filterSettingsIndex', () => {
  it('returns every entry for an empty or blank query', () => {
    expect(filterSettingsIndex('')).toEqual(SETTINGS_SEARCH_INDEX)
    expect(filterSettingsIndex('   ')).toEqual(SETTINGS_SEARCH_INDEX)
  })

  it('matches labels case-insensitively', () => {
    expect(filterSettingsIndex('MOTION').map((entry) => entry.label)).toEqual(['Reduce motion'])
  })

  it('matches keywords and section names beyond labels', () => {
    const byKeyword = filterSettingsIndex('ollama')
    expect(byKeyword.map((entry) => entry.section)).toEqual(['settings-endpoints'])

    const bySection = filterSettingsIndex('appearance')
    expect(bySection.length).toBeGreaterThan(1)
    for (const entry of bySection) {
      expect(entry.section).toBe('settings-appearance')
    }
  })

  it('returns nothing for unknown terms', () => {
    expect(filterSettingsIndex('zzz-not-a-setting')).toEqual([])
  })
})

describe('SettingsSearch', () => {
  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  })

  it('renders the search input and the full index up front', () => {
    render(<SettingsSearch />)

    expect(screen.getByRole('searchbox', { name: 'Search settings' })).toBeInTheDocument()
    expect(screen.getAllByRole('button')).toHaveLength(SETTINGS_SEARCH_INDEX.length)
    expect(screen.getByText('Theme')).toBeInTheDocument()
    expect(screen.getByText('Model endpoints')).toBeInTheDocument()
  })

  it('filters results as the query changes and shows an empty state', async () => {
    const user = userEvent.setup()
    render(<SettingsSearch />)

    await user.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'motion')

    expect(screen.getByRole('button', { name: /Reduce motion/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Theme$/ })).not.toBeInTheDocument()

    await user.type(screen.getByRole('searchbox', { name: 'Search settings' }), ' zzz')

    expect(screen.getByText('No matching settings')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Reduce motion/ })).not.toBeInTheDocument()
  })

  it('scrolls to the section anchor of the clicked result', async () => {
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    const anchor = document.createElement('div')
    anchor.id = 'settings-appearance'
    document.body.appendChild(anchor)
    try {
      const user = userEvent.setup()
      render(<SettingsSearch />)

      await user.type(screen.getByRole('searchbox', { name: 'Search settings' }), 'motion')
      await user.click(screen.getByRole('button', { name: /Reduce motion/ }))
    } finally {
      anchor.remove()
    }

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth' })
  })
})
