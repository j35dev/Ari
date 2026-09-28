import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  activeSkillSets,
  formatSkillCatalog,
  listAriCoreSkills,
  matchSlashSkill,
  readSkillBody,
  readTrustedSkillRoots,
  setWorkspaceSkillTrust,
  SKILL_BODY_CAP,
} from './skills'

describe('Ari Core skills', () => {
  it('loads user skills and hides untrusted project skills from the active set', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-skills-'))
    try {
      const home = join(root, 'home')
      const project = join(root, 'proj')
      const worktree = join(root, 'worktree')
      await mkdir(join(home, '.agents', 'skills', 'hello'), { recursive: true })
      await mkdir(join(project, '.agents', 'skills', 'local'), { recursive: true })
      await mkdir(join(project, '.agents', 'skills', 'read'), { recursive: true })
      await writeFile(join(home, '.agents', 'skills', 'hello', 'SKILL.md'), '---\nname: hello\ndescription: Hi\n---\nHello body\n')
      await writeFile(join(project, '.agents', 'skills', 'local', 'SKILL.md'), '---\nname: local\n---\nLocal body\n')
      await writeFile(join(project, '.agents', 'skills', 'read', 'SKILL.md'), '---\nname: read\n---\nRead body\n')
      const untrusted = await listAriCoreSkills(project, [], { homeDir: home, builtInNames: ['read', 'bash'] })
      expect(untrusted.find((skill) => skill.name === 'local')?.problem).toBe('untrusted-project')
      expect(activeSkillSets(untrusted).slashSkills.map((skill) => skill.name)).toEqual(['hello'])
      await setWorkspaceSkillTrust(root, project, true)
      expect(await readTrustedSkillRoots(root)).toEqual([project])
      const trusted = await listAriCoreSkills(project, await readTrustedSkillRoots(root), {
        homeDir: home,
        builtInNames: ['read'],
      })
      expect(trusted.find((skill) => skill.name === 'local')?.trusted).toBe(true)
      expect(trusted.find((skill) => skill.name === 'read')?.problem).toBe('duplicate-name')
      const sets = activeSkillSets(trusted)
      expect(sets.slashSkills.map((skill) => skill.name).sort()).toEqual(['hello', 'local', 'read'])
      expect(sets.toolSkills.map((skill) => skill.name)).not.toContain('read')
      const worktreeSkills = await listAriCoreSkills(worktree, await readTrustedSkillRoots(root), {
        homeDir: home,
      })
      expect(worktreeSkills.find((skill) => skill.name === 'local')).toBeUndefined()
      expect(matchSlashSkill('/local do it', sets.slashSkills)?.name).toBe('local')
      expect(matchSlashSkill('/nope', sets.slashSkills)).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('caps a skill body and drops catalog entries past the budget', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ari-skill-body-'))
    try {
      const file = join(root, 'SKILL.md')
      await writeFile(file, 'x'.repeat(SKILL_BODY_CAP + 20), 'utf8')
      const body = await readSkillBody(file)
      expect(body.endsWith('\n[truncated]')).toBe(true)
      expect(body.length).toBe(SKILL_BODY_CAP + '\n[truncated]'.length)
      const catalog = formatSkillCatalog(
        [
          { name: 'a', dirName: 'a', sourcePath: file, scope: 'user', trusted: true, summary: 'one' },
          { name: 'b', dirName: 'b', sourcePath: file, scope: 'user', trusted: true, summary: 'two' },
        ],
        8,
      )
      expect(catalog).toContain('more skills omitted')
      expect(catalog).not.toContain('two')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
