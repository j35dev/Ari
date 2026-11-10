import { mkdir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { ControlFailure, type CreatedProject } from '@ari/contracts/agent-control'
import { HELM_PROJECT_ID } from '@ari/contracts/helm'
import type { ProjectStore } from '@ari/engine/projects'
import { GitService } from '@ari/engine/git'
import type { ProjectCreationFailureDetails, ProjectCreationProgress } from '@ari/contracts/project'

export interface ProjectCreateDeps {
  projects: ProjectStore
  home: string
  userData: string
  /** Awaited at each boundary; throwing stops creation without retrying or cleanup. */
  onProgress?(progress: Readonly<ProjectCreationProgress>): Promise<void>
}

export function projectSlug(name: string): string {
  const slug =
    name
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .slice(0, 80)
      .replace(/^-+|-+$/g, '') || 'project'
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(slug) ? `project-${slug}` : slug
}

function pathKey(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
}

export function defaultProjectsFolder(
  projects: readonly { id: string; path: string }[],
  home: string,
): string {
  const folders = projects.filter((project) => project.id !== HELM_PROJECT_ID)
  const counts = new Map<string, { path: string; count: number }>()
  for (const project of folders) {
    const parent = dirname(resolve(project.path))
    const key = pathKey(parent)
    const previous = counts.get(key)
    if (previous) previous.count++
    else counts.set(key, { path: parent, count: 1 })
  }
  const majority = [...counts.values()].find((entry) => entry.count > folders.length / 2)
  return majority?.path ?? join(home, 'Projects')
}

/** Resolve through the nearest existing ancestor, including paths not yet created. */
async function physicalPath(path: string): Promise<string> {
  const absolute = resolve(path)
  try {
    return await realpath(absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(absolute)
    if (parent === absolute) return absolute
    return join(await physicalPath(parent), basename(absolute))
  }
}

function inside(path: string, root: string): boolean {
  const rel = relative(pathKey(root), pathKey(path))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function systemFolders(): string[] {
  if (process.platform === 'win32')
    return [
      process.env['SystemRoot'] ?? 'C:\\Windows',
      process.env['ProgramFiles'] ?? 'C:\\Program Files',
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      process.env['ProgramData'] ?? 'C:\\ProgramData',
    ]
  return [
    '/bin',
    '/sbin',
    '/usr',
    '/etc',
    '/lib',
    '/lib64',
    '/dev',
    '/proc',
    '/sys',
    '/System',
    '/Library',
  ]
}

async function safePath(deps: ProjectCreateDeps, path: string): Promise<string> {
  if (!isAbsolute(path))
    throw new ControlFailure('invalid_request', 'Project path must be an absolute folder.')
  return checkPath(deps, await physicalPath(path))
}

async function checkPath(deps: ProjectCreateDeps, folder: string): Promise<string> {
  if (folder.length > 32_767)
    throw new ControlFailure('invalid_request', 'Project path is too long.')
  const [home, userData, ...systems] = await Promise.all(
    [deps.home, deps.userData, ...systemFolders()].map(physicalPath),
  )
  if (
    pathKey(folder) === pathKey(parse(folder).root) ||
    pathKey(folder) === pathKey(home!) ||
    inside(folder, userData!) ||
    systems.some((system) => inside(folder, system)) ||
    (process.platform === 'win32' &&
      relative(parse(folder).root, folder)
        .split(sep)
        .some(
          (part) =>
            /[:<>"|?*]|[. ]$/.test(part) ||
            /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
        ))
  )
    throw new ControlFailure(
      'unsafe_project_path',
      'Choose a project folder outside system folders, your home folder itself and Ari’s data folder.',
    )
  return folder
}

async function makeFolder(folder: string): Promise<boolean> {
  await mkdir(dirname(folder), { recursive: true })
  try {
    await mkdir(folder)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!(await stat(folder)).isDirectory())
      throw new ControlFailure('invalid_request', 'Project path must be a folder.')
    return false
  }
}

export async function createProject(
  deps: ProjectCreateDeps,
  input: { name: string; path?: string },
): Promise<CreatedProject> {
  const projects = await deps.projects.load()
  let folder: string
  let created: boolean
  if (input.path !== undefined) {
    folder = await safePath(deps, input.path)
    created = await makeFolder(folder)
  } else {
    let parent = await physicalPath(defaultProjectsFolder(projects, deps.home))
    const slug = projectSlug(input.name)
    try {
      await checkPath(deps, join(parent, slug))
    } catch (error) {
      if (!(error instanceof ControlFailure) || error.code !== 'unsafe_project_path') throw error
      parent = await physicalPath(join(deps.home, 'Projects'))
    }
    for (let suffix = 1; ; suffix++) {
      folder = await checkPath(deps, join(parent, suffix === 1 ? slug : `${slug}-${suffix}`))
      // mkdir is exclusive: simultaneous names cannot adopt one another's folder.
      await mkdir(dirname(folder), { recursive: true })
      try {
        await mkdir(folder)
        created = true
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    }
  }
  // mkdir/adoption and the receipt write are not atomic. A process exit before
  // folder_ready is persisted can leave this folder without a durable identity.
  // Once recorded, later phases must never select another folder as a retry.
  const displayName = (name: string): string =>
    name
      .replace(/\p{Cc}/gu, ' ')
      .trim()
      .slice(0, 120) || 'Project'
  let progress: Readonly<ProjectCreationProgress> = Object.freeze({
    name: displayName(input.name),
    path: folder,
    created,
    phase: 'folder_ready',
  })
  let failureCode: ProjectCreationFailureDetails['failureCode'] = 'project_progress_failed'
  const report = async (phase: ProjectCreationProgress['phase'], registered?: CreatedProject) => {
    progress = Object.freeze({
      ...progress,
      phase,
      ...(registered
        ? {
            name: displayName(registered.name),
            path: registered.path,
            projectId: registered.projectId,
          }
        : {}),
    })
    failureCode = 'project_progress_failed'
    await deps.onProgress?.(progress)
    failureCode = phase === 'registering' ? 'project_registration_failed' : 'project_git_failed'
  }
  try {
    await report('folder_ready')
    if (created) {
      const git = new GitService()
      await report('repository_check')
      const existing = await git.isRepo(folder)
      if (!existing.ok) throw new Error('Project repository check failed.')
      if (!existing.value) {
        await report('git_init')
        const init = await git.runPlumbing(folder, ['init', '--template='])
        if (!init.ok) throw new Error('Project Git initialization failed.')
        // ManagedWorkspaces snapshots read HEAD before making an isolated worktree.
        await report('initial_commit')
        const commit = await git.runPlumbing(
          folder,
          [
            '-c',
            'core.hooksPath=',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--allow-empty',
            '-m',
            'Initial project',
          ],
          {
            ...process.env,
            GIT_AUTHOR_NAME: 'Ari',
            GIT_AUTHOR_EMAIL: 'ari@localhost',
            GIT_COMMITTER_NAME: 'Ari',
            GIT_COMMITTER_EMAIL: 'ari@localhost',
          },
        )
        if (!commit.ok) throw new Error('Project initial commit failed.')
      }
    }
    await report('registering')
    const project = await deps.projects.open(folder, input.name)
    const result = { projectId: project.id, name: project.name, path: project.path, created }
    await report('registered', result)
    return result
  } catch {
    throw new ControlFailure(
      'uncertain_outcome',
      'Project creation may have partially completed. Inspect the preserved folder before recovery.',
      { projectCreation: progress, failureCode } satisfies ProjectCreationFailureDetails,
    )
  }
}
