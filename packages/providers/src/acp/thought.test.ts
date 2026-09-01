import { describe, expect, it } from 'vitest'
import { findThoughtOption, looksLikeThoughtAxis, thoughtEffortsFromSession } from './thought'

describe('findThoughtOption', () => {
  it('prefers the spec thought_level category', () => {
    const option = findThoughtOption([
      { id: 'model', category: 'model', type: 'select', options: [{ value: 'm1' }] },
      {
        id: 'effort',
        category: 'thought_level',
        type: 'select',
        options: [{ value: 'high', name: 'High' }],
      },
    ])
    expect(option?.id).toBe('effort')
  })

  it('matches id/name aliases when category is missing (Claude effort, Codex reasoning_effort)', () => {
    expect(
      findThoughtOption([{ id: 'effort', name: 'Effort', type: 'select', options: [{ value: 'low' }] }])
        ?.id,
    ).toBe('effort')
    expect(
      findThoughtOption([
        { id: 'reasoning_effort', name: 'Reasoning', type: 'select', options: [{ value: 'xhigh' }] },
      ])?.id,
    ).toBe('reasoning_effort')
    expect(
      findThoughtOption([{ id: 'thinking', name: 'Thinking', type: 'select', options: [{ value: 'max' }] }])
        ?.id,
    ).toBe('thinking')
  })

  it('never steals the model or permission-mode selectors', () => {
    expect(
      findThoughtOption([
        { id: 'mode', category: 'mode', name: 'Mode', type: 'select', options: [{ value: 'plan' }] },
        { id: 'model', category: 'model', name: 'Model', type: 'select', options: [{ value: 'm' }] },
      ]),
    ).toBeNull()
  })
})

describe('looksLikeThoughtAxis', () => {
  it("recognizes pi's thinking levels", () => {
    expect(looksLikeThoughtAxis(['off', 'minimal', 'low', 'medium', 'high', 'xhigh'])).toBe(true)
  })

  it('rejects permission vocabularies (claude, opencode)', () => {
    expect(looksLikeThoughtAxis(['default', 'acceptEdits', 'bypassPermissions', 'plan'])).toBe(false)
    expect(looksLikeThoughtAxis(['build', 'plan'])).toBe(false)
  })
})

describe('thoughtEffortsFromSession', () => {
  it('projects thought_level config options including the current value', () => {
    const catalog = thoughtEffortsFromSession({
      sessionId: 's',
      configOptions: [
        {
          id: 'effort',
          category: 'thought_level',
          type: 'select',
          currentValue: 'medium',
          options: [
            { value: 'low', name: 'Low', description: 'Faster' },
            { value: 'medium', name: 'Medium' },
            { value: 'high', name: 'High' },
          ],
        },
      ],
    })
    expect(catalog.currentId).toBe('medium')
    expect(catalog.options.map((o) => o.id)).toEqual(['low', 'medium', 'high'])
    expect(catalog.options[0]?.description).toBe('Faster')
  })

  it('falls back to thinking-shaped modes when no config option exists', () => {
    const catalog = thoughtEffortsFromSession({
      sessionId: 's',
      modes: {
        currentModeId: 'low',
        availableModes: [
          { id: 'off', name: 'Off' },
          { id: 'low', name: 'Low' },
          { id: 'xhigh', name: 'Extra high' },
        ],
      },
    })
    expect(catalog.currentId).toBe('low')
    expect(catalog.options.map((o) => o.id)).toEqual(['off', 'low', 'xhigh'])
  })

  it('returns an empty catalog when the agent advertises neither', () => {
    expect(thoughtEffortsFromSession({ sessionId: 's' })).toEqual({ currentId: null, options: [] })
  })
})
