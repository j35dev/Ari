// Plans hosted visualization screenshots. Importing this file never launches a browser.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

export const VISUAL_TYPES = [
  'bar',
  'line',
  'area',
  'scatter',
  'pie',
  'donut',
  'radar',
  'heatmap',
  'treemap',
  'funnel',
  'graph',
  'timeline',
  'gantt',
  'metrics',
  'comparison',
]
export const DESKTOP_WIDTH = 1280
export const MOBILE_WIDTH = 390
export const REVIEW_HEIGHT = 1600
export const MOBILE_BREAKPOINT = 600
/** Branch base, before the shared visual-quality repair. */
export const BEFORE_COMMIT = 'ed8380b3a097576c5744c5b9e6196556d32651bc'
export const THEMES = [
  { theme: 'light', themeId: 'porcelain' },
  { theme: 'dark', themeId: 'obsidian' },
]

const HISTORICAL_TIMELINE = {
  version: 1,
  type: 'timeline',
  title: 'Release progress',
  data: {
    events: [
      { label: 'v0.2.0', date: '2026-08-30', description: 'Previous release' },
      { label: 'v0.3.13', date: 'in progress', tone: 'warning' },
    ],
  },
}

function longLabel(prefix) {
  return `${prefix} ${'label '.repeat(16)}`.trim().slice(0, 80)
}

function stressSource(type) {
  if (type === 'bar') {
    const labels = Array.from({ length: 12 }, (_, index) => longLabel(`Category ${index + 1}`))
    return {
      version: 1,
      type,
      title: 'Long category labels',
      labels,
      series: [
        { name: longLabel('Before the change'), values: labels.map((_, index) => index + 1) },
        { name: longLabel('After the change'), values: labels.map((_, index) => index) },
      ],
      unit: 'hours',
    }
  }
  if (type === 'pie') {
    return {
      version: 1,
      type,
      title: 'Long slice labels',
      items: Array.from({ length: 8 }, (_, index) => ({
        label: longLabel(`Slice ${index + 1}`),
        value: index + 1,
      })),
    }
  }
  if (type === 'funnel') {
    return {
      version: 1,
      type,
      title: 'Long stage labels',
      items: Array.from({ length: 6 }, (_, index) => ({
        label: longLabel(`Stage ${index + 1}`),
        value: 12 - index,
      })),
    }
  }
  if (type === 'timeline') {
    return {
      version: 1,
      type,
      title: 'Long event labels',
      events: Array.from({ length: 6 }, (_, index) => ({
        label: longLabel(`Event ${index + 1}`),
        date: `2026-08-${String(index + 1).padStart(2, '0')}`,
        description: longLabel('What changed in this step'),
      })),
    }
  }
  if (type === 'heatmap') {
    const xLabels = Array.from({ length: 16 }, (_, index) => longLabel(`Col ${index + 1}`))
    const yLabels = Array.from({ length: 4 }, (_, index) => longLabel(`Row ${index + 1}`))
    return {
      version: 1,
      type,
      title: 'Many heatmap labels',
      xLabels,
      yLabels,
      values: yLabels.map((_, row) => xLabels.map((_, column) => row * 16 + column)),
    }
  }
  if (type === 'comparison') {
    return {
      version: 1,
      type,
      title: 'Long comparison cells',
      columns: ['Local install', 'Hosted runner', 'Shared preview', 'Archived build'],
      rows: Array.from({ length: 8 }, (_, index) => ({
        label: longLabel(`Row ${index + 1}`),
        values: [
          longLabel('Stays on this machine'),
          longLabel('Runs only in hosted CI'),
          longLabel('Needs a separate review'),
          longLabel('Kept for the record'),
        ],
      })),
    }
  }
  return null
}

export function documentedFences(skill) {
  const section = skill.slice(
    skill.indexOf('## Inline visualizations'),
    skill.indexOf('## Typed tasks'),
  )
  if (!section.includes('## Inline visualizations'))
    throw new Error('Skill visualization section is missing')
  return [...section.matchAll(/```ari-viz\r?\n([\s\S]*?)\r?\n```/g)].map((match) => {
    const source = match[1]?.trim() ?? ''
    const value = JSON.parse(source)
    if (!VISUAL_TYPES.includes(value.type))
      throw new Error('Documented example has an unknown type')
    return { type: value.type, source }
  })
}

export function hostedReviewEnv(env) {
  return (
    env.VISUALIZATION_REVIEW_CI === '1' &&
    env.CI === 'true' &&
    env.GITHUB_ACTIONS === 'true' &&
    env.RUNNER_ENVIRONMENT === 'github-hosted' &&
    isAbsolute(env.RUNNER_TEMP ?? '')
  )
}

export function chromeCandidates(env = {}) {
  return [
    env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter((path) => typeof path === 'string' && path.startsWith('/'))
}

export function selectBrowser(candidates, exists) {
  return candidates.find((path) => exists(path)) ?? null
}

export function resolveEsbuild(root) {
  try {
    const rootRequire = createRequire(join(root, 'package.json'))
    const vitestPkg = rootRequire.resolve('vitest/package.json')
    const vitePkg = createRequire(vitestPkg).resolve('vite/package.json')
    const esbuildPkg = createRequire(vitePkg).resolve('esbuild/package.json')
    const bin = join(dirname(esbuildPkg), 'bin/esbuild')
    return existsSync(bin) ? bin : null
  } catch {
    return null
  }
}

function caseId(kind, type, theme, width) {
  return `${kind}-${type}-${theme}-${width}`
}

export function reviewPlan({ commit, skill }) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Review plan needs the full commit')
  const fences = documentedFences(skill)
  const byType = new Map(fences.map((fence) => [fence.type, fence.source]))
  for (const type of VISUAL_TYPES) {
    if (!byType.has(type)) throw new Error(`Documented examples are missing ${type}`)
  }
  const cases = []
  const push = (kind, type, source) => {
    for (const { theme, themeId } of THEMES) {
      for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
        cases.push({
          id: caseId(kind, type, theme, width),
          kind,
          type,
          theme,
          themeId,
          width,
          height: REVIEW_HEIGHT,
          commit,
          source,
        })
      }
    }
  }
  for (const type of VISUAL_TYPES) push('documented', type, byType.get(type))
  for (const type of ['bar', 'pie', 'funnel', 'timeline', 'heatmap', 'comparison']) {
    push('stress', type, JSON.stringify(stressSource(type)))
  }
  push('historical', 'timeline', JSON.stringify(HISTORICAL_TIMELINE))
  push(
    'error',
    'timeline',
    JSON.stringify({ version: 1, type: 'timeline', title: 'Missing events' }),
  )
  return {
    commit,
    desktopWidth: DESKTOP_WIDTH,
    mobileWidth: MOBILE_WIDTH,
    height: REVIEW_HEIGHT,
    mobileBreakpoint: MOBILE_BREAKPOINT,
    themes: THEMES,
    captured: false,
    cases,
  }
}

export function pairedReviewPlan({ before, after, skill }) {
  if (!/^[a-f0-9]{40}$/.test(before) || !/^[a-f0-9]{40}$/.test(after)) {
    throw new Error('Review plan needs the full before and after commits')
  }
  if (before === after) throw new Error('Before and after commits must differ')
  const beforePlan = reviewPlan({ commit: before, skill })
  const afterPlan = reviewPlan({ commit: after, skill })
  if (beforePlan.cases.length !== afterPlan.cases.length) {
    throw new Error('Before and after case counts differ')
  }
  const tag = (sourceRole, plan) =>
    plan.cases.map((item, index) => {
      const other = sourceRole === 'before' ? afterPlan.cases[index] : beforePlan.cases[index]
      if (item.source !== other.source || item.kind !== other.kind || item.width !== other.width) {
        throw new Error(`Case ${item.id} is not the same input at both commits`)
      }
      return { ...item, sourceRole, id: `${sourceRole}-${item.id}`, commit: plan.commit }
    })
  const cases = [...tag('before', beforePlan), ...tag('after', afterPlan)]
  return {
    before,
    after,
    desktopWidth: DESKTOP_WIDTH,
    mobileWidth: MOBILE_WIDTH,
    height: REVIEW_HEIGHT,
    mobileBreakpoint: MOBILE_BREAKPOINT,
    themes: THEMES,
    captured: false,
    caseCount: cases.length,
    cases,
  }
}

export async function extractSource(root, commit, dest) {
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Source extract needs the full commit')
  await mkdir(dest, { recursive: true })
  const archive = join(dest, 'source.tar')
  execFileSync(
    'git',
    ['archive', '--format=tar', '-o', archive, commit, 'packages/ui', 'packages/contracts'],
    { cwd: root, windowsHide: true },
  )
  execFileSync('tar', ['-xf', archive, '-C', dest], { cwd: root, windowsHide: true })
  await rm(archive)
}

function repoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

function htmlPage({ bundleHref, tokensHref, visualHref, item }) {
  const payload = item.source.replaceAll('<', '\\u003c')
  return `<!doctype html>
<html data-ari-theme="${item.themeId}">
<head>
<meta charset="utf-8">
<link rel="stylesheet" href="${tokensHref}">
<link rel="stylesheet" href="${visualHref}">
<style>
  html, body { margin: 0; background: var(--ari-bg); color: var(--ari-fg); }
  #frame { width: ${item.width}px; }
</style>
</head>
<body>
<div id="ari-layer-root"></div>
<div id="frame"><div id="root"></div></div>
<script type="application/json" id="viz-source">${payload}</script>
<script src="${bundleHref}"></script>
</body>
</html>
`
}

export async function bundleRenderer(installRoot, esbuildBin, outDir, options = {}) {
  const sourceRoot = options.sourceRoot ?? installRoot
  const outfile = options.outfile ?? 'bundle.js'
  const entry = join(outDir, options.entryName ?? 'render-visualization.tsx')
  const visualization = join(sourceRoot, 'packages/ui/src/visualization/Visualization.tsx')
  const uiRequire = createRequire(join(installRoot, 'packages/ui/package.json'))
  const react = dirname(uiRequire.resolve('react/package.json')).replaceAll('\\', '/')
  const reactDom = dirname(uiRequire.resolve('react-dom/package.json')).replaceAll('\\', '/')
  const contracts = join(sourceRoot, 'packages/contracts/src/visualization.ts').replaceAll('\\', '/')
  await mkdir(outDir, { recursive: true })
  await writeFile(
    entry,
    `import { createRoot } from 'react-dom/client'
import { Visualization } from ${JSON.stringify(visualization)}
const source = document.getElementById('viz-source')?.textContent ?? ''
const root = document.getElementById('root')
if (!root) throw new Error('missing root')
createRoot(root).render(<Visualization source={source} />)
`,
  )
  const esbuildUrl = pathToFileURL(join(dirname(esbuildBin), '..', 'lib', 'main.js')).href
  const loaded = await import(esbuildUrl)
  const esbuild = loaded.default?.build ? loaded.default : loaded
  await esbuild.build({
    absWorkingDir: installRoot,
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    resolveExtensions: ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.json'],
    loader: { '.css': 'empty' },
    alias: {
      react,
      'react-dom': reactDom,
      '@ari/contracts/visualization': contracts,
    },
    nodePaths: [
      join(installRoot, 'node_modules'),
      join(installRoot, 'packages/ui/node_modules'),
      join(installRoot, 'packages/contracts/node_modules'),
    ],
    outfile: join(outDir, outfile),
    logLevel: 'warning',
    tsconfigRaw: { compilerOptions: { jsx: 'react-jsx' } },
  })
}

async function writeReview(outDir, plan, status, logLines) {
  await mkdir(outDir, { recursive: true })
  await writeFile(join(outDir, 'plan.json'), JSON.stringify({ ...plan, ...status }, null, 2) + '\n')
  await writeFile(join(outDir, 'review.log'), `${logLines.join('\n')}\n`)
}

async function main() {
  if (!hostedReviewEnv(process.env)) {
    throw new Error('Visualization screenshots require an explicitly opted-in GitHub-hosted runner')
  }
  const root = repoRoot()
  const after = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
  }).trim()
  const skill = await readFile(join(root, 'apps/desktop/resources/cli/ari/SKILL.md'), 'utf8')
  const plan = pairedReviewPlan({ before: BEFORE_COMMIT, after, skill })
  const outDir = join(process.env.RUNNER_TEMP, 'ari-visualization-review')
  const logLines = [
    `before ${plan.before}`,
    `after ${plan.after}`,
    `cases ${plan.caseCount}`,
    `desktop ${plan.desktopWidth}`,
    `mobile ${plan.mobileWidth}`,
    `height ${plan.height}`,
  ]
  const chrome = selectBrowser(chromeCandidates(process.env), existsSync)
  const esbuildBin = resolveEsbuild(root)
  const status = {
    before: plan.before,
    after: plan.after,
    captured: false,
    caseCount: plan.caseCount,
    desktopWidth: plan.desktopWidth,
    mobileWidth: plan.mobileWidth,
    height: plan.height,
    themes: plan.themes,
    reason: null,
    files: [],
  }
  if (!chrome || !esbuildBin) {
    status.reason = !chrome
      ? 'No system Chrome is installed. Screenshots were not captured and Chrome was not downloaded.'
      : 'esbuild from the existing install could not be resolved. Screenshots were not captured.'
    logLines.push(status.reason)
    await writeReview(outDir, plan, status, logLines)
    console.log(JSON.stringify(status))
    return
  }
  const beforeRoot = join(outDir, 'before-source')
  const groups = [
    { sourceRole: 'before', sourceRoot: beforeRoot, bundleDir: join(outDir, 'before-bundle') },
    { sourceRole: 'after', sourceRoot: root, bundleDir: join(outDir, 'after-bundle') },
  ]
  try {
    await extractSource(root, plan.before, beforeRoot)
    for (const group of groups) {
      await bundleRenderer(root, esbuildBin, group.bundleDir, { sourceRoot: group.sourceRoot })
      const bundleHref = pathToFileURL(join(group.bundleDir, 'bundle.js')).href
      const tokensHref = pathToFileURL(join(group.sourceRoot, 'packages/ui/src/tokens.css')).href
      const visualHref = pathToFileURL(
        join(group.sourceRoot, 'packages/ui/src/visualization/visualization.css'),
      ).href
      const cases = plan.cases.filter((candidate) => candidate.sourceRole === group.sourceRole)
      for (const item of cases) {
        const page = join(outDir, `${item.id}.html`)
        const png = join(outDir, `${item.id}.png`)
        await writeFile(page, htmlPage({ bundleHref, tokensHref, visualHref, item }))
        execFileSync(
          chrome,
          [
            '--headless=new',
            '--disable-gpu',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--hide-scrollbars',
            '--force-device-scale-factor=1',
            `--user-data-dir=${join(process.env.RUNNER_TEMP, 'ari-visualization-chrome', item.id)}`,
            `--window-size=${item.width},${item.height}`,
            `--screenshot=${png}`,
            pathToFileURL(page).href,
          ],
          { cwd: outDir, windowsHide: true, timeout: 60_000 },
        )
        if (!existsSync(png)) throw new Error(`Screenshot missing for ${item.id}`)
        status.files.push({
          id: item.id,
          sourceRole: item.sourceRole,
          kind: item.kind,
          type: item.type,
          theme: item.theme,
          themeId: item.themeId,
          width: item.width,
          height: item.height,
          commit: item.commit,
          png,
        })
        logLines.push(
          `${item.id} ${item.commit} ${item.theme} ${item.width} ${item.kind} ${item.type}`,
        )
      }
    }
    status.captured = true
    await writeReview(outDir, plan, status, logLines)
    console.log(JSON.stringify({ ...status, files: status.files.length }))
  } catch (error) {
    status.reason = error instanceof Error ? error.message : String(error)
    logLines.push(status.reason)
    await writeReview(outDir, plan, status, logLines)
    throw error
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
