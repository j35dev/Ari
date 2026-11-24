import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { performance } from 'node:perf_hooks'
import { URL } from 'node:url'

// Run the actual pure prompt builder, erasing types without changing its logic.
const moduleUrl = (source) =>
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
const helm = stripTypeScriptTypes(
  await readFile(new URL('../packages/contracts/src/helm.ts', import.meta.url), 'utf8'),
)
const preamble = stripTypeScriptTypes(
  await readFile(new URL('../packages/engine/src/control-preamble.ts', import.meta.url), 'utf8'),
)
const { controlPreamble } = await import(
  moduleUrl(preamble.replace("'@ari/contracts/helm'", JSON.stringify(moduleUrl(helm))))
)
const variants = {
  project: { projectId: 'project' },
  coordinator: { projectId: 'helm' },
  child: { projectId: 'project', parentSessionId: 'parent' },
}
const rows = []
for (const [kind, session] of Object.entries(variants)) {
  const text = controlPreamble(session, null, 'prompt')
  let characters = 0
  const started = performance.now()
  for (let n = 0; n < 100_000; n++) characters += controlPreamble(session, null, 'prompt').length
  rows.push({
    kind,
    characters: text.length,
    words: text.split(/\s+/).length,
    approximateTokensAtFourChars: Math.ceil(text.length / 4),
    averageMicroseconds: (performance.now() - started) / 100,
    generatedCharacters: characters,
  })
}
console.log(JSON.stringify(rows, null, 2))
