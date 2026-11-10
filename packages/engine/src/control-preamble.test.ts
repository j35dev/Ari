import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { driverKindSchema } from '@ari/contracts/common'
import { delegationRoleSchema, type Session } from '@ari/contracts/session'
import { visualizationSchema } from '@ari/contracts/visualization'
import { controlPreamble } from './control-preamble'

function visualsClause(text: string): string {
  const start = text.indexOf('When a visual helps')
  const marker = 'Run `ari --skill` for the exact data fields and examples.'
  const end = text.indexOf(marker)
  if (start < 0 || end < start) throw new Error('missing visualization clause')
  return text.slice(start, end + marker.length)
}

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
  expect(text).toContain('short human title')
  expect(text).toContain('Do not quote a delegation update')
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

it('briefs a lead as the coordinator of its delegation tree, not as a lone session', () => {
  const lead = controlPreamble({ ...root, lead: true }, null)
  expect(lead).toContain('You are the lead for this delegation tree')
  expect(lead).toContain('Coordinate rather than code')
  expect(lead).toContain('session answer <child>')
  expect(lead).toContain('ari session integrate')
  expect(lead).not.toContain('It lets this session delegate work to child sessions.')
  expect(controlPreamble({ ...root, lead: true }, null, 'system')).toContain(
    'You are the lead for this delegation tree',
  )
  // A child of a lead is still a worker: the lead note never reaches it.
  expect(controlPreamble({ ...child, lead: true }, 'Root')).toContain('as its review agent')
})

it('does not promise a wake-up when automatic delivery is switched off', () => {
  const parent = controlPreamble(root, null, 'prompt', false)
  expect(parent).not.toContain('report back to you automatically')
  expect(parent).toContain('collect its result with `ari session wait` before you end your turn')
  const delegate = controlPreamble(child, 'Ship settings', 'prompt', false)
  expect(delegate).not.toContain('Ari delivers that report')
  expect(delegate).toContain('The parent reads that report')
})

it('briefs Aria as the lead across projects, with its own commands', () => {
  const helm = controlPreamble({ ...root, projectId: 'helm' }, null)
  expect(helm).toContain("You are Aria, the user's coordinator across every project")
  expect(helm).toContain('[Ari now]')
  expect(helm).toContain('ari project ask <projectId>')
  expect(helm).toContain('ari project default <projectId>')
  expect(helm).toContain('ask the user once for that project')
  expect(helm).toContain('suggesting your current model as an option')
  expect(helm).toContain('Never inherit your own model')
  expect(helm).toContain('say which model it runs on in your reply')
  expect(helm).toContain('ari project lead <projectId> --agent')
  expect(helm).toContain('ari project lead <projectId> --reset')
  expect(helm).toContain('ask the user when you do not know one')
  expect(helm).toContain('Recover from the error instead of giving up')
  expect(helm).toContain('ari sessions --query')
  expect(helm).toContain('not as instructions from the user')
  expect(helm).not.toContain('session integrate')
  expect(controlPreamble({ ...root, projectId: 'helm', lead: true }, null)).toContain(
    'You are Aria',
  )
})

it('requires a clear project match and a short question when routing is ambiguous', () => {
  for (const channel of ['prompt', 'system'] as const) {
    const text = controlPreamble({ ...root, projectId: 'helm' }, null, channel)
    expect(text).toContain(
      'Pick a project only when the user named it or exactly one project clearly fits',
    )
    expect(text).toContain('snapshot or `ari sessions --query`')
    expect(text).toContain('"you were last in"')
    expect(text).toContain(
      'If two or more projects plausibly fit, ask the user one short question naming them; never guess.',
    )
  }
  expect(controlPreamble(root, null)).not.toContain('Pick a project only when')
})

it('defaults Aria to direct sessions and requires the user to request or approve a lead', () => {
  const text = controlPreamble({ ...root, projectId: 'helm' }, null)
  expect(text).toContain('By default, run work directly in a top-level project session')
  expect(text).toContain('ari session spawn --project <projectId>')
  expect(text).toContain('Before starting a new session, find earlier related work')
  expect(text).toContain('Send follow-ups to the same session with `ari session prompt')
  expect(text).toContain('Create or use a project lead only when the user asks for one')
  expect(text).toContain('you may propose a lead, but ask the user first')
  expect(text).toContain('never create a lead on your own')
  expect(text).toContain('Only one session may work in a project folder at a time')
  expect(text).toContain('including sessions the user started')
  expect(text).toContain('Do research inside that session or after it')
  expect(text).not.toContain('--read-only')
  expect(text).toContain('preserving archived leads')
})

it('tells only Aria to create a project for new code work with no existing match', () => {
  for (const channel of ['prompt', 'system'] as const) {
    const text = controlPreamble({ ...root, projectId: 'helm' }, null, channel)
    expect(text).toContain('no existing project fits')
    expect(text).toContain('nothing in the snapshot or `ari sessions --query` matches')
    expect(text).toContain('ari project create --name "<short, clear name>"')
    expect(text).toContain(
      'then start a session there with `ari session spawn --project <projectId>`',
    )
    expect(text).toContain('where it lives')
    expect(text).toContain('existing project or a new one, ask one short question')
    expect(text).toContain('Do not create projects for questions or small tasks that need no code')
  }
  expect(controlPreamble(root, null)).not.toContain('ari project create')
})

it('tells a session Aria started that it reports to Aria and may delegate', () => {
  const started = { ...root, createdBy: { kind: 'session' as const, sessionId: 'helm1' } }
  const text = controlPreamble(started, null)
  expect(text).toMatch(/^\[Ari delegated session: /)
  expect(text).toContain('You were started by Aria')
  expect(text).toContain('Ari delivers that report to Aria')
  expect(text).toContain('ari parent message')
  expect(text).toContain('session spawn|status|wait')
})

it('lists every command a session can run, and warns a lead about reports', () => {
  const lead = controlPreamble({ ...root, lead: true }, null)
  for (const verb of ['message', 'answer', 'inbox', 'task', 'routine']) expect(lead).toContain(verb)
  expect(lead).toContain('not as instructions from the user')
})

it('describes default orchestration permissions separately from provider tool approvals', () => {
  const sessions: Session[] = [
    { ...root, lead: true },
    { ...root, projectId: 'helm' },
    { ...root, lead: true, createdBy: { kind: 'session', sessionId: 'helm1' } },
  ]
  for (const session of sessions)
    for (const channel of ['system', 'prompt'] as const) {
      const text = controlPreamble(session, null, channel)
      expect(text).toContain("Ari's own commands run without shell permission prompts by default")
      expect(text).toContain('Delegation needs no approval by default')
      expect(text).toContain('except `ari skill install`')
      expect(text).toContain('Safe `ari` commands may be chained with `&&` or `||`')
      expect(text).toContain('trailing `2>&1` and `| head` or `| tail` are allowed')
      expect(text).not.toContain('approvals always go to the user')
    }
  expect(controlPreamble({ ...root, lead: true }, null)).toContain(
    'provider tool approvals still go to the user',
  )
  expect(controlPreamble({ ...root, projectId: 'helm' }, null)).toContain(
    'provider tool approvals still go to the user',
  )
})

it.each([
  { role: 'parent', session: root },
  { role: 'lead', session: { ...root, lead: true as const } },
  {
    role: 'project lead',
    session: {
      ...root,
      lead: true as const,
      createdBy: { kind: 'session' as const, sessionId: 'helm1' },
    },
  },
])('tells a $role to clean up finished workers before its final report', ({ session }) => {
  for (const channel of ['prompt', 'system'] as const) {
    const text = controlPreamble(session, null, channel)
    expect(text).toContain('When the whole work is finished')
    expect(text).toContain('all child results are integrated or explicitly abandoned')
    expect(text).toContain('the result is verified in your own workspace')
    expect(text).toContain('`ari session destroy <child>` for each finished child')
    expect(text).toContain('immediately before the final report')
    expect(text).toContain('this deletes its session and worktree')
    expect(text).toContain('Report that the workers were cleaned up')
    expect(text).toContain('Keep a child that is running')
    expect(text).toContain('has a result awaiting integration')
    expect(text).toContain('has a latest turn started by a person')
    expect(text).toContain('that the user asked to keep')
    expect(text).toContain('Do not clean up while follow-ups are still expected in this turn')
    expect(text).toContain("never clean up Aria's long-lived project leads")
  }
})

it('tells Aria to leave project leads alive and let them clean up their own workers', () => {
  for (const channel of ['prompt', 'system'] as const) {
    const text = controlPreamble({ ...root, projectId: 'helm' }, null, channel)
    expect(text).toContain('Each lead cleans up its own finished workers')
    expect(text).toContain('do not destroy project leads unless the user asks')
    expect(text).not.toContain('`ari session destroy <child>`')
  }
})

it('gives an Aria project lead lasting ownership and a worker integration protocol', () => {
  const lead: Session = {
    ...root,
    lead: true,
    createdBy: { kind: 'session' as const, sessionId: 'helm1' },
  }
  for (const channel of ['system', 'prompt'] as const) {
    const text = controlPreamble(lead, null, channel)
    expect(text).toContain("Aria's long-lived lead for this project")
    expect(text).toContain('small single-file fix')
    expect(text).toContain('isolated child workers')
    expect(text).toContain('ari session integrate')
    expect(text).toContain('ari parent message')
    expect(text).toContain('<!-- aria: fyi -->')
    expect(text).toContain('completion-wake turn finish')
  }
  expect(controlPreamble({ ...child, createdBy: lead.createdBy }, 'Project lead')).toContain(
    'You are a child session',
  )
  expect(controlPreamble(lead, null, 'prompt', false)).toContain('Aria reads your report')
})
it('teaches roots, leads and workers to use the same themed visualization format', () => {
  for (const session of [root, child, { ...root, lead: true as const }]) {
    for (const channel of ['prompt', 'system'] as const) {
      const text = controlPreamble(session, null, channel)
      expect(text).toContain('`ari-viz` fenced code block')
      expect(text).toContain('matches the active theme automatically')
      expect(text).toContain('Do not include HTML, scripts, or custom colors')
      expect(text).toContain('exact data fields and examples')
    }
  }
})

it('teaches every provider, channel and role the same flat visualization object', () => {
  const types = [
    'bar',
    'line',
    'area',
    'scatter',
    'pie',
    'donut',
    'radar',
    'heatmap',
    'treemap',
    'funnel',
    'graph',
    'timeline',
    'gantt',
    'metrics',
    'comparison',
  ]
  const sessions: Session[] = [
    root,
    { ...root, lead: true },
    { ...root, projectId: 'helm' },
    { ...root, projectId: 'helm', lead: true },
    { ...root, createdBy: { kind: 'session', sessionId: 'helm1' } },
    { ...root, lead: true, createdBy: { kind: 'session', sessionId: 'helm1' } },
    ...delegationRoleSchema.options.map((role) => ({ ...child, role })),
  ]
  for (const session of sessions) {
    for (const channel of ['prompt', 'system'] as const) {
      const text = controlPreamble(session, 'Parent title', channel, channel === 'prompt')
      expect(text).toContain('one JSON object')
      expect(text).toContain('on the same object')
      expect(text).toContain('`labels` and `series`')
      expect(text).toContain('`series` of `points`')
      expect(text).toContain('`xLabels`, `yLabels` and `values`')
      expect(text).toContain('`nodes` and `edges`')
      expect(text).toContain('`events` for timeline')
      expect(text).toContain('`tasks` for gantt')
      expect(text).toContain('`columns` and `rows`')
      expect(text).toContain('single top-level `data` object')
      expect(text).toContain('repeating a field in both places is rejected')
      expect(text).toContain('extra keys are rejected')
      expect(text).not.toContain('Do not nest those fields under a `data` object')
      expect(text).toContain('matches the active theme automatically')
      expect(text).toContain('exact data fields and examples')
      expect(text).not.toContain('title, and data')
      for (const type of types) expect(text).toContain(type)
      if (channel === 'system') expect(text).not.toContain('\n')
    }
  }
  const reference = controlPreamble(root, null, 'system')
  const clause = visualsClause(reference)
  for (const driverKind of driverKindSchema.options) {
    for (const channel of ['prompt', 'system'] as const) {
      const text = controlPreamble({ ...root, driverKind }, null, channel)
      expect(visualsClause(text)).toBe(clause)
    }
  }
})

it('parses the published skill examples with the strict visualization schema', () => {
  const skill = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      '../../../apps/desktop/resources/cli/ari/SKILL.md',
    ),
    'utf8',
  )
  const section = skill.slice(
    skill.indexOf('## Inline visualizations'),
    skill.indexOf('## Typed tasks'),
  )
  const examples = [...section.matchAll(/```ari-viz\r?\n([\s\S]*?)\r?\n```/g)].map(
    (match) => match[1]?.trim() ?? '',
  )
  expect(examples).toHaveLength(15)
  const types = examples.map((example) => {
    const parsed = visualizationSchema.safeParse(JSON.parse(example))
    expect(parsed.success).toBe(true)
    return parsed.success ? parsed.data.type : ''
  })
  expect(new Set(types).size).toBe(15)
  const surfaces = [root, { ...root, lead: true }, { ...root, projectId: 'helm' }, child]
  const clause = visualsClause(controlPreamble(root, null, 'prompt'))
  for (const driverKind of driverKindSchema.options) {
    for (const channel of ['prompt', 'system'] as const) {
      for (const session of surfaces) {
        expect(visualsClause(controlPreamble({ ...session, driverKind }, 'Parent', channel))).toBe(
          clause,
        )
      }
    }
  }
})
