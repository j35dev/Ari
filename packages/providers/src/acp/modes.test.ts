import { describe, expect, it } from 'vitest'
import { agentModesFromSession, classifyAgentMode } from './modes'
import type { AcpNewSessionResult } from './protocol'

describe('classifyAgentMode', () => {
  it('maps the major harness vocabularies onto Ari modes', () => {
    // claude-code
    expect(classifyAgentMode('default')).toBe('ask')
    expect(classifyAgentMode('acceptEdits')).toBe('allow-edits')
    expect(classifyAgentMode('bypassPermissions')).toBe('full')
    expect(classifyAgentMode('plan')).toBe('ask')
    // codex
    expect(classifyAgentMode('chat')).toBe('ask')
    expect(classifyAgentMode('yolo')).toBe('full')
    expect(classifyAgentMode('full-access')).toBe('full')
    expect(classifyAgentMode('danger-full-access')).toBe('full')
    // opencode
    expect(classifyAgentMode('build')).toBe('allow-edits')
    expect(classifyAgentMode('workspace-write')).toBe('allow-edits')
    // claude-agent-acp's classifier-approved mode also behaves like full
    expect(classifyAgentMode('auto')).toBe('full')
  })

  it('returns null for thinking axes and unknown vocabularies', () => {
    for (const value of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'something', 'dontAsk']) {
      expect(classifyAgentMode(value)).toBeNull()
    }
  })
})

describe('agentModesFromSession', () => {
  it('reads the mode config option and classifies its values', () => {
    const created: AcpNewSessionResult = {
      sessionId: 's1',
      configOptions: [
        {
          id: 'mode',
          name: 'Mode',
          category: 'mode',
          type: 'select',
          currentValue: 'yolo',
          options: [
            { value: 'chat', name: 'Chat' },
            { value: 'yolo', name: 'Yolo', description: 'Skip every approval' },
            { value: 'mystery', name: 'Mystery' },
          ],
        },
      ],
    }
    expect(agentModesFromSession(created)).toEqual({
      currentId: 'yolo',
      options: [
        { id: 'chat', label: 'Chat', ariMode: 'ask' },
        { id: 'yolo', label: 'Yolo', description: 'Skip every approval', ariMode: 'full' },
        { id: 'mystery', label: 'Mystery', ariMode: null },
      ],
    })
  })

  it('falls back to a permission-shaped modes list', () => {
    const created: AcpNewSessionResult = {
      sessionId: 's1',
      modes: {
        currentModeId: 'build',
        availableModes: [
          { id: 'build', name: 'Build' },
          { id: 'plan', name: 'Plan' },
        ],
      },
    }
    expect(agentModesFromSession(created)).toEqual({
      currentId: 'build',
      options: [
        { id: 'build', label: 'Build', ariMode: 'allow-edits' },
        { id: 'plan', label: 'Plan', ariMode: 'ask' },
      ],
    })
  })

  it('ignores a thinking-shaped modes list (pi)', () => {
    const created: AcpNewSessionResult = {
      sessionId: 's1',
      modes: {
        currentModeId: 'low',
        availableModes: [
          { id: 'off', name: 'Off' },
          { id: 'low', name: 'Low' },
          { id: 'xhigh', name: 'Extra high' },
        ],
      },
    }
    expect(agentModesFromSession(created)).toEqual({ currentId: null, options: [] })
  })

  it('ignores a mode option whose vocabulary classifies to nothing', () => {
    const created: AcpNewSessionResult = {
      sessionId: 's1',
      configOptions: [
        {
          id: 'mode',
          category: 'mode',
          type: 'select',
          options: [
            { value: 'off', name: 'Off' },
            { value: 'xhigh', name: 'Extra high' },
          ],
        },
      ],
    }
    expect(agentModesFromSession(created)).toEqual({ currentId: null, options: [] })
  })
})
