import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readSkillDirectory } from '@ari/providers/extensions'
import { realpathSync } from 'node:fs'

/**
 * Ari Core's own skill catalog. Pass-through agents load their skills
 * themselves; this module only serves the built-in harness, and only from
 * `.agents/skills`. It does not read the trust file — callers pass the
 * roots they already loaded.
 */

export const SKILL_BODY_CAP = 32 * 1024
export const CATALOG_CHAR_BUDGET = 4_000

export interface AriSkillRecord {
  name: string
  dirName: string
  summary?: string
  sourcePath: string
  scope: 'user' | 'project'
  trusted: boolean
  problem?: 'unreadable' | 'untrusted-project' | 'duplicate-name'
}

export async function listAriCoreSkills(
  workspacePath: string,
  trustedRoots: readonly string[],
  options: { homeDir?: string; builtInNames?: readonly string[] } = {},
): Promise<AriSkillRecord[]> {
  const home = options.homeDir ?? homedir()
  const builtIn = new Set(options.builtInNames ?? [])
  const trusted = new Set(trustedRoots.map(normalizePath))
  const projectTrusted = trusted.has(normalizePath(workspacePath))
  const project = await skillsIn(join(workspacePath, '.agents', 'skills'), 'project')
  const user = await skillsIn(join(home, '.agents', 'skills'), 'user')
  const records: AriSkillRecord[] = []
  for (const skill of project) {
    const problem = !projectTrusted
      ? 'untrusted-project'
      : skill.problem ?? (builtIn.has(skill.name) ? 'duplicate-name' : undefined)
    records.push({
      ...skill,
      trusted: projectTrusted && skill.problem !== 'unreadable',
      ...(problem ? { problem } : {}),
    })
  }
  for (const skill of user) {
    const shadowed =
      projectTrusted && project.some((row) => row.dirName === skill.dirName && row.problem !== 'unreadable')
    const problem = skill.problem ?? (builtIn.has(skill.name) ? 'duplicate-name' : undefined)
    records.push({
      ...skill,
      trusted: !shadowed && skill.problem !== 'unreadable',
      ...(problem ? { problem } : {}),
    })
  }
  return records
}

/** Skills the turn may invoke. Untrusted and unreadable rows stay in the inventory only. */
export function activeSkillSets(skills: readonly AriSkillRecord[]): {
  slashSkills: AriSkillRecord[]
  toolSkills: AriSkillRecord[]
} {
  const slashSkills = skills.filter((skill) => skill.trusted)
  const blocked = new Set(
    slashSkills.filter((skill) => skill.problem === 'duplicate-name').map((skill) => skill.name),
  )
  return {
    slashSkills,
    toolSkills: slashSkills.filter((skill) => !blocked.has(skill.name)),
  }
}

/** Name plus summary. Drops whole entries past the budget. */
export function formatSkillCatalog(
  skills: readonly AriSkillRecord[],
  budget = CATALOG_CHAR_BUDGET,
): string {
  const lines: string[] = []
  let used = 0
  let omitted = 0
  for (const skill of skills) {
    const line = skill.summary ? `- ${skill.name}: ${skill.summary}` : `- ${skill.name}`
    if (used + line.length + 1 > budget) {
      omitted++
      continue
    }
    lines.push(line)
    used += line.length + 1
  }
  if (omitted > 0) lines.push(`(${omitted} more skills omitted)`)
  return lines.join('\n')
}

/** First token `/name`, matched against frontmatter name then directory name. */
export function matchSlashSkill(
  prompt: string,
  skills: readonly AriSkillRecord[],
): AriSkillRecord | null {
  const token = /^\/(\S+)/.exec(prompt.trim())?.[1]
  if (!token) return null
  return skills.find((skill) => skill.name === token) ?? skills.find((skill) => skill.dirName === token) ?? null
}

export async function readSkillBody(sourcePath: string): Promise<string> {
  try {
    const raw = await readFile(sourcePath, 'utf8')
    if (raw.length <= SKILL_BODY_CAP) return raw
    return `${raw.slice(0, SKILL_BODY_CAP)}\n[truncated]`
  } catch {
    return 'This skill could not be read.'
  }
}

export async function readTrustedSkillRoots(dir: string): Promise<string[]> {
  const { readFile: read } = await import('node:fs/promises')
  try {
    const parsed: unknown = JSON.parse(await read(join(dir, 'trusted-skill-roots.json'), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
  } catch {
    return []
  }
}

/** Exact workspace path. A sibling or a managed worktree is a different entry. */
export async function setWorkspaceSkillTrust(
  dir: string,
  workspacePath: string,
  trusted: boolean,
): Promise<boolean> {
  const { mkdir, rename, writeFile } = await import('node:fs/promises')
  const target = resolve(workspacePath)
  const current = await readTrustedSkillRoots(dir)
  const next = current.filter((entry) => normalizePath(entry) !== normalizePath(target))
  if (trusted) next.push(target)
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'trusted-skill-roots.json')
  await writeFile(`${file}.tmp`, JSON.stringify(next, null, 2), 'utf8')
  await rename(`${file}.tmp`, file)
  return trusted
}

async function skillsIn(
  root: string,
  scope: 'user' | 'project',
): Promise<Omit<AriSkillRecord, 'trusted'>[]> {
  const { readdir } = await import('node:fs/promises')
  let names: string[]
  try {
    names = await readdir(root)
  } catch {
    return []
  }
  let rootReal: string
  try {
    rootReal = realpathSync(root)
  } catch {
    return []
  }
  const out: Omit<AriSkillRecord, 'trusted' | 'problem'>[] = []
  for (const dirName of names) {
    const skill = await readSkillDirectory(join(root, dirName), rootReal)
    if (!skill) continue
    out.push({
      name: skill.name,
      dirName,
      ...(skill.summary ? { summary: skill.summary } : {}),
      sourcePath: skill.sourcePath,
      scope,
      ...(skill.problem ? { problem: skill.problem } : {}),
    })
  }
  return out
}

function normalizePath(value: string): string {
  const resolved = resolve(value)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}
