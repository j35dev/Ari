// @vitest-environment node
import { expect, it } from 'vitest'
import { transformWithEsbuild } from 'vite'
import { insertMainCommonjsShim, MAIN_COMMONJS_SHIM } from '../../packaging/main-commonjs-shim'

it('inserts main-process require globals without parsing import-like SDK diagnostics', async () => {
  const source = `import fs from 'node:fs';
const sdkDiagnostic = " import 'example'; ";
export const lookup = () => require.resolve('optional-package');
export { fs, sdkDiagnostic };`
  const code = insertMainCommonjsShim(source, 'es')!
  expect(code).toBe(MAIN_COMMONJS_SHIM + source)
  await expect(transformWithEsbuild(code, 'main.mjs', { loader: 'js', target: 'node22' })).resolves.toBeDefined()
  expect(insertMainCommonjsShim(source, 'cjs')).toBeNull()
})
