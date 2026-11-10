// Plans hosted visualization screenshots. Importing this file never launches a browser.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
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

export async function bundleRenderer(root, esbuildBin, outDir) {
  const entry = join(outDir, 'render-visualization.tsx')
  const visualization = join(root, 'packages/ui/src/visualization/Visualization.tsx')
  const uiRequire = createRequire(join(root, 'packages/ui/package.json'))
  const react = dirname(uiRequire.resolve('react/package.json')).replaceAll('\\', '/')
  const reactDom = dirname(uiRequire.resolve('react-dom/package.json')).replaceAll('\\', '/')
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
  execFileSync(
    process.execPath,
    [
      esbuildBin,
      entry,
      '--bundle',
      '--format=iife',
      '--platform=browser',
      '--jsx=automatic',
      '--resolve-extensions=.tsx,.ts,.jsx,.js,.mjs,.json',
      '--loader:.css=empty',
      `--alias:react=${react}`,
      `--alias:react-dom=${reactDom}`,
      `--outfile=${join(outDir, 'bundle.js')}`,
      '--log-level=warning',
    ],
    { cwd: root, windowsHide: true },
  )
}

async function main() {
  if (!hostedReviewEnv(process.env)) {
    throw new Error('Visualization screenshots require an explicitly opted-in GitHub-hosted runner')
  }
  const root = repoRoot()
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    windowsHide: true,
    encoding: 'utf8',
  }).trim()
  const skill = await readFile(join(root, 'apps/desktop/resources/cli/ari/SKILL.md'), 'utf8')
  const plan = reviewPlan({ commit, skill })
  const outDir = join(process.env.RUNNER_TEMP, 'ari-visualization-review')
  await mkdir(outDir, { recursive: true })
  const chrome = selectBrowser(chromeCandidates(process.env), existsSync)
  const esbuildBin = resolveEsbuild(root)
  const status = {
    commit,
    captured: false,
    caseCount: plan.cases.length,
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
    await writeFile(
      join(outDir, 'plan.json'),
      JSON.stringify({ ...plan, ...status }, null, 2) + '\n',
    )
    console.log(JSON.stringify(status))
    return
  }
  await bundleRenderer(root, esbuildBin, outDir)
  const bundleHref = pathToFileURL(join(outDir, 'bundle.js')).href
  const tokensHref = pathToFileURL(join(root, 'packages/ui/src/tokens.css')).href
  const visualHref = pathToFileURL(
    join(root, 'packages/ui/src/visualization/visualization.css'),
  ).href
  for (const item of plan.cases) {
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
        `--user-data-dir=${join(outDir, `chrome-${item.id}`)}`,
        `--window-size=${item.width},${item.height}`,
        `--screenshot=${png}`,
        pathToFileURL(page).href,
      ],
      { cwd: outDir, windowsHide: true, timeout: 60_000 },
    )
    if (!existsSync(png)) throw new Error(`Screenshot missing for ${item.id}`)
    status.files.push({
      id: item.id,
      kind: item.kind,
      type: item.type,
      theme: item.theme,
      themeId: item.themeId,
      width: item.width,
      height: item.height,
      commit,
      png,
    })
  }
  status.captured = true
  await writeFile(join(outDir, 'plan.json'), JSON.stringify({ ...plan, ...status }, null, 2) + '\n')
  console.log(JSON.stringify({ ...status, files: status.files.length }))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
