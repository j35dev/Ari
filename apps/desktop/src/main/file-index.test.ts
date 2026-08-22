import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FILE_INDEX_MAX_DEPTH, ProjectFileIndex, walkWorkspaceFiles } from './file-index'

let dir: string
let root: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ari-file-index-'))
  root = join(dir, 'ws')
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function seedSampleTree(): Promise<void> {
  await mkdir(join(root, 'src', 'deep'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(join(root, '.vscode'), { recursive: true })
  await mkdir(join(root, 'dist'), { recursive: true })
  await Promise.all([
    writeFile(join(root, 'readme.md'), ''),
    writeFile(join(root, '.env'), ''),
    writeFile(join(root, 'src', 'a.ts'), ''),
    writeFile(join(root, 'src', 'deep', 'b.ts'), ''),
    writeFile(join(root, 'node_modules', 'pkg', 'x.js'), ''),
    writeFile(join(root, '.git', 'config'), ''),
    writeFile(join(root, '.vscode', 'settings.json'), ''),
    writeFile(join(root, 'dist', 'out.js'), ''),
  ])
}

async function writeChain(segments: number): Promise<string> {
  const parts = Array.from({ length: segments - 1 }, (_, i) => `d${i + 1}`)
  const dirPath = join(root, ...parts)
  await mkdir(dirPath, { recursive: true })
  const file = join(dirPath, 'leaf.txt')
  await writeFile(file, '')
  return file
}

describe('walkWorkspaceFiles', () => {
  it('lists files workspace-relative, skipping ignored dirs and root dotfiles', async () => {
    await seedSampleTree()
    expect(await walkWorkspaceFiles(root, FILE_INDEX_MAX_DEPTH * 1000)).toEqual([
      'readme.md',
      'src/a.ts',
      'src/deep/b.ts',
    ])
  })

  it('enforces the depth limit at 6 path segments', async () => {
    await writeChain(6)
    await writeChain(7)
    const paths = await walkWorkspaceFiles(root, FILE_INDEX_MAX_DEPTH * 1000)
    expect(paths).toEqual(['d1/d2/d3/d4/d5/leaf.txt'])
  })

  it('stops collecting once the cap is reached', async () => {
    await Promise.all(
      ['a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt'].map((name) =>
        writeFile(join(root, name), ''),
      ),
    )
    expect(await walkWorkspaceFiles(root, 3)).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })
})

describe('ProjectFileIndex', () => {
  it('builds its initial listing from the workspace walk', async () => {
    await seedSampleTree()
    const index = new ProjectFileIndex(root)
    await index.init()
    expect(index.paths()).toEqual(['readme.md', 'src/a.ts', 'src/deep/b.ts'])
  })

  it('buffers batches until initialized, then applies them', async () => {
    await seedSampleTree()
    const late = join(root, 'src', 'late.ts')
    await writeFile(late, '')
    const index = new ProjectFileIndex(root)
    await index.applyBatch([late])
    expect(index.paths()).toEqual([])
    await index.init()
    expect(index.paths()).toEqual(['readme.md', 'src/a.ts', 'src/deep/b.ts', 'src/late.ts'])
  })

  it('adds and removes entries from change batches', async () => {
    const index = new ProjectFileIndex(root)
    await index.init()
    expect(index.paths()).toEqual([])

    const added = join(root, 'new.ts')
    await writeFile(added, '')
    await index.applyBatch([added, join(root, 'src')])
    expect(index.paths()).toEqual(['new.ts'])

    await rm(added)
    await index.applyBatch([added])
    expect(index.paths()).toEqual([])
  })

  it('ignores absolute paths outside the workspace root', async () => {
    const outside = join(dir, 'outside.txt')
    await writeFile(outside, '')
    const index = new ProjectFileIndex(root)
    await index.init()
    await index.applyBatch([outside])
    expect(index.paths()).toEqual([])
  })

  it('enforces the cap on init and on later additions', async () => {
    await Promise.all(
      ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((name) => writeFile(join(root, name), '')),
    )
    const index = new ProjectFileIndex(root, { cap: 3 })
    await index.init()
    expect(index.paths()).toEqual(['a.txt', 'b.txt', 'c.txt'])

    const extra = join(root, 'e.txt')
    await writeFile(extra, '')
    await index.applyBatch([extra])
    expect(index.size).toBe(3)
    expect(index.paths()).not.toContain('e.txt')
  })
})
