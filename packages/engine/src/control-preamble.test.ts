import { expect, it } from 'vitest'
import type { Session } from '@ari/contracts/session'
import { controlPreamble, sessionInstructions } from './control-preamble'

const root: Session = {
  id: 'root',
  projectId: 'p',
  title: 'Root',
  driverKind: 'claude',
  modelId: null,
  permissionMode: 'ask',
  status: 'idle',
  createdAt: 1,
  updatedAt: 1,
}
const child = { ...root, id: 'child', parentSessionId: 'root', role: 'review' as const }

it('tells a root session it can delegate and will be told when children finish', () => {
  const text = controlPreamble(root, null)
  expect(text).toContain('not written by the user')
  expect(text).toContain('session spawn|status|wait')
  expect(text).toContain('end your turn rather than polling')
  expect(text).toContain('`ari --skill`')
  expect(text).toContain('Never disclose ARI_CONTROL_TOKEN')
})

it('briefs a child on its employer, role and report instead of the orchestration surface', () => {
  const text = controlPreamble(child, 'Ship settings')
  expect(text).toMatch(/^\[Ari delegated session: /)
  expect(text).toContain('working for the session "Ship settings" as its review agent')
  expect(text).toContain('End each turn with a short report')
  expect(text).toContain('ari parent message')
  expect(text).not.toContain('session spawn')
  expect(controlPreamble({ ...child, role: 'general' }, null)).toContain(
    'working for a parent session. Do the assignment',
  )
})

it('states the same facts plainly, on one line, for a provider system channel', () => {
  for (const text of [
    controlPreamble(root, null, 'system'),
    controlPreamble(child, 'Ship settings', 'system'),
  ]) {
    expect(text).toMatch(/^You are running inside the Ari desktop app/)
    expect(text).not.toContain('\n')
    // Wording that marks a note as planted has no place where Ari is the author.
    expect(text).not.toContain('not written by the user')
    expect(text).not.toContain('[')
    expect(text).toContain('Do not print the ARI_CONTROL_TOKEN environment variable.')
  }
  expect(controlPreamble(root, null, 'system')).toContain('session spawn|status|wait')
  expect(controlPreamble(child, 'Ship settings', 'system')).toContain('as its review agent')
})

it('does not promise a wake-up when automatic delivery is switched off', () => {
  const parent = controlPreamble(root, null, 'prompt', false)
  expect(parent).not.toContain('report back to you automatically')
  expect(parent).toContain('collect its result with `ari session wait` before you end your turn')
  const delegate = controlPreamble(child, 'Ship settings', 'prompt', false)
  expect(delegate).not.toContain('Ari delivers that report')
  expect(delegate).toContain('The parent reads that report')
})

it('puts a persona ahead of the control note and drops whatever is absent', () => {
  const note = controlPreamble(root, null, 'system')
  expect(sessionInstructions('You are Forge.', note)).toBe(`You are Forge.\n\n${note}`)
  expect(sessionInstructions('You are Forge.', null)).toBe('You are Forge.')
  expect(sessionInstructions(null, note)).toBe(note)
  expect(sessionInstructions('  \n', null)).toBeNull()
  expect(sessionInstructions(null, null)).toBeNull()
})
