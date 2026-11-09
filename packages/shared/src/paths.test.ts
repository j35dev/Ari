import { join, parse } from 'node:path'
import { expect, it } from 'vitest'
import { isWithinRoot, pathKey, sameRoot } from './paths'

it('normalizes filesystem identities and tests directory boundaries, including drive roots', () => {
  const root = join(process.cwd(), 'workspace')
  expect(sameRoot(root, join(root, '..', 'workspace'))).toBe(true)
  expect(isWithinRoot(root, root)).toBe(true)
  expect(isWithinRoot(join(root, 'src'), root)).toBe(true)
  expect(isWithinRoot(`${root}-other`, root)).toBe(false)
  expect(isWithinRoot(join(root, '..'), root)).toBe(false)
  expect(isWithinRoot(root, parse(root).root)).toBe(true)
  if (process.platform === 'win32') expect(pathKey(root.toUpperCase())).toBe(pathKey(root))
})
