// @vitest-environment node
import { globSync, readFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import defaultConfig, { hasNodeDocblock, nodeSuites } from '../vitest.config'

type InlineProject = {
  test?: {
    name?: string
    setupFiles?: string[]
    exclude?: string[]
  }
}

describe('node test environment', () => {
  it('node suites run without the DOM test setup', () => {
    expect(typeof Element).toBe('undefined')
    expect(globalThis.ResizeObserver).toBeUndefined()
    const matcherPrototype = Object.getPrototypeOf(expect(null)) as unknown as Record<
      string,
      unknown
    >
    expect(typeof matcherPrototype.toBeInTheDocument).toBe('undefined')
  })

  it('every node-docblock suite runs in the node project', () => {
    const cwd = fileURLToPath(new URL('../', import.meta.url))
    const testGlobs = ['src/**/*.test.{ts,tsx}', 'packaging/**/*.test.js']
    const files = testGlobs
      .flatMap((pattern) => globSync(pattern, { cwd }))
      .map((file) => file.split(sep).join('/'))
      .sort()

    // Deliberately form-independent: any mention of a node directive near the
    // top of a file must have landed in the node project, so a docblock form
    // the config misses fails here by file name instead of as "Element is not
    // defined" inside the DOM setup at run time.
    const mentionsNode = files.filter((file) =>
      (readFileSync(join(cwd, file), 'utf8').split(/\r?\n/).slice(0, 3) ?? []).some(
        (line) => /@vitest-environment[\s*]+node\b/.test(line),
      ),
    )

    expect(mentionsNode).toEqual(nodeSuites)
    expect(nodeSuites).toEqual(files.filter((file) => hasNodeDocblock(readFileSync(join(cwd, file), 'utf8'))))
    expect(nodeSuites).toContain('src/test-env.node.test.ts')

    const projects = (defaultConfig.test?.projects ?? []) as unknown as InlineProject[]
    const domProject = projects.find((project) => project.test?.name === 'dom')
    const nodeProject = projects.find((project) => project.test?.name === 'node')

    expect(nodeProject?.test?.setupFiles).toBeUndefined()
    expect(domProject?.test?.setupFiles).toEqual(['./src/test-setup.dom.ts'])
    expect(domProject?.test?.exclude).toEqual(expect.arrayContaining(nodeSuites))
  })
})
