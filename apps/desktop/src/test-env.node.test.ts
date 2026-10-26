// @vitest-environment node
import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import defaultConfig, { nodeSuites } from '../vitest.config'

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
    const docblockSuites = testGlobs
      .flatMap((pattern) => globSync(pattern, { cwd }))
      .filter(
        (file) =>
          (readFileSync(join(cwd, file), 'utf8').split(/\r?\n/, 1)[0] ?? '') ===
          '// @vitest-environment node',
      )
      .sort()

    expect(docblockSuites).toEqual(nodeSuites)
    expect(nodeSuites).toContain('src/test-env.node.test.ts')

    const projects = (defaultConfig.test?.projects ?? []) as unknown as InlineProject[]
    const domProject = projects.find((project) => project.test?.name === 'dom')
    const nodeProject = projects.find((project) => project.test?.name === 'node')

    expect(nodeProject?.test?.setupFiles).toBeUndefined()
    expect(domProject?.test?.setupFiles).toEqual(['./src/test-setup.dom.ts'])
    expect(domProject?.test?.exclude).toEqual(expect.arrayContaining(nodeSuites))
  })
})
