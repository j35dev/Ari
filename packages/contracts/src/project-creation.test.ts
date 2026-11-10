import { expect, it } from 'vitest'
import { projectCreationFailureDetailsSchema, projectCreationProgressSchema } from './project'

const ready = {
  name: 'New app',
  path: 'D:/Projects/new-app',
  created: true,
  phase: 'folder_ready',
}

it('keeps exact recovery identity through the six bounded creation phases', () => {
  for (const phase of [
    'folder_ready',
    'repository_check',
    'git_init',
    'initial_commit',
    'registering',
    'registered',
  ]) {
    const progress = {
      ...ready,
      phase,
      ...(phase === 'registered' ? { projectId: 'proj_new' } : {}),
    }
    expect(projectCreationProgressSchema.parse(progress)).toEqual(progress)
    expect(
      projectCreationFailureDetailsSchema.parse({
        projectCreation: progress,
        failureCode: 'project_progress_failed',
      }).projectCreation,
    ).toEqual(progress)
  }
})

it('rejects missing registration identities, extra data, unknown phases and oversized fields', () => {
  for (const progress of [
    { ...ready, phase: 'registered' },
    { ...ready, phase: 'registered', projectId: 'p'.repeat(129) },
    { ...ready, projectId: 'proj_early' },
    { ...ready, phase: 'retry' },
    { ...ready, name: 'n'.repeat(121) },
    { ...ready, name: 'Unsafe\nname' },
    { ...ready, path: 'p'.repeat(32_768) },
    { ...ready, rawError: 'unbounded exception output' },
  ])
    expect(projectCreationProgressSchema.safeParse(progress).success).toBe(false)
  expect(
    projectCreationFailureDetailsSchema.safeParse({
      projectCreation: ready,
      failureCode: 'internal_error',
    }).success,
  ).toBe(false)
})
