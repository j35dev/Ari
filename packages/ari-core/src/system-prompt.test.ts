import { describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSystemPrompt, loadContextFiles } from './system-prompt'

async function workspace(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'ari-prompt-'))
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

describe('buildSystemPrompt', () => {
  it('anchors the model to the workspace, platform, and date', async () => {
    const { dir, cleanup } = await workspace()
    try {
      const prompt = await buildSystemPrompt({ workspacePath: dir })
      expect(prompt).toContain('You are Ari Core')
      expect(prompt).toContain(`Working directory: ${dir.replace(/\\/g, '/')}`)
      expect(prompt).toContain(`Platform: ${process.platform === 'win32' ? 'Windows' : process.platform}`)
      expect(prompt).toMatch(/Today's date: \d{4}-\d{2}-\d{2}/)
      expect(prompt).toContain('- read: Read a file')
      expect(prompt).toContain('- bash: Run shell commands')
    } finally {
      await cleanup()
    }
  })

  it('lists the top-level workspace layout, skipping build noise', async () => {
    const { dir, cleanup } = await workspace()
    try {
      await mkdir(join(dir, 'src'), { recursive: true })
      await mkdir(join(dir, 'node_modules'), { recursive: true })
      await writeFile(join(dir, 'package.json'), '{}', 'utf8')
      const prompt = await buildSystemPrompt({ workspacePath: dir })
      expect(prompt).toContain('Workspace layout (top level):')
      expect(prompt).toContain('src/')
      expect(prompt).toContain('package.json')
      expect(prompt).not.toContain('node_modules/')
    } finally {
      await cleanup()
    }
  })

  it('embeds AGENTS.md as a project instruction', async () => {
    const { dir, cleanup } = await workspace()
    try {
      await writeFile(join(dir, 'AGENTS.md'), 'Always use pnpm.', 'utf8')
      const prompt = await buildSystemPrompt({ workspacePath: dir })
      expect(prompt).toContain('<project_context>')
      expect(prompt).toContain('<project_instructions path="AGENTS.md">')
      expect(prompt).toContain('Always use pnpm.')
    } finally {
      await cleanup()
    }
  })

  it('respects the context-file char budget', async () => {
    const { dir, cleanup } = await workspace()
    try {
      await writeFile(join(dir, 'AGENTS.md'), 'a'.repeat(5000), 'utf8')
      await writeFile(join(dir, 'CLAUDE.md'), 'b'.repeat(5000), 'utf8')
      const files = await loadContextFiles(dir, 6000)
      expect(files).toHaveLength(2)
      expect(files[0]?.content).toHaveLength(5000)
      expect(files[1]?.content).toContain('[truncated]')
      expect(files[1]?.content.length).toBeLessThanOrEqual(1013)
    } finally {
      await cleanup()
    }
  })

  it('drops instruction files once the budget is exhausted', async () => {
    const { dir, cleanup } = await workspace()
    try {
      await writeFile(join(dir, 'AGENTS.md'), 'a'.repeat(100), 'utf8')
      await writeFile(join(dir, 'CLAUDE.md'), 'b'.repeat(100), 'utf8')
      const files = await loadContextFiles(dir, 100)
      expect(files.map((f) => f.path)).toEqual(['AGENTS.md'])
    } finally {
      await cleanup()
    }
  })
})
