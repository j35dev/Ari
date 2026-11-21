import type { Plugin } from 'vite'
import MagicString from 'magic-string'

/** Node >=22 is supplied by Electron. Keep the upstream shim's runtime behavior. */
export const MAIN_COMMONJS_SHIM = `
import { createRequire as __ariCreateRequire } from 'node:module';
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require = __ariCreateRequire(import.meta.url);
`

export function insertMainCommonjsShim(code: string, format: string): string | null {
  if (format !== 'es' || !/__filename|__dirname|require\(|require\.resolve\(/.test(code))
    return null
  // Prepending needs no import regex: SDK diagnostics contain import-like strings,
  // which electron-vite 5's regex mistakes for imports and splices into a literal.
  return MAIN_COMMONJS_SHIM + code
}

/** Replace only electron-vite's main-process shim insertion, never dependency bundling. */
export function mainCommonjsShimPlugin(): Plugin {
  return {
    name: 'ari:main-commonjs-shim',
    configResolved(config) {
      const shim = config.plugins.find((plugin) => plugin.name === 'vite:esm-shim')
      if (!shim) throw new Error('electron-vite main CommonJS shim plugin was not found')
      shim.renderChunk = (code, _chunk, { format, sourcemap }) => {
        const mapped = insertMainCommonjsShim(code, format)
        if (mapped === null) return null
        const source = new MagicString(code).prepend(MAIN_COMMONJS_SHIM)
        return {
          code: source.toString(),
          map: sourcemap ? source.generateMap({ hires: 'boundary' }).toString() : null,
        }
      }
    },
  }
}
