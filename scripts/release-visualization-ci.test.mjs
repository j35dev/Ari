import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  BEFORE_COMMIT,
  DESKTOP_WIDTH,
  MOBILE_BREAKPOINT,
  MOBILE_WIDTH,
  VISUAL_TYPES,
  assertCaptureTools,
  assertReviewResult,
  bundleRenderer,
  chromeCandidates,
  esbuildApiEntry,
  extractSource,
  hostedReviewEnv,
  pairedReviewPlan,
  readReviewMarker,
  resolveEsbuild,
  reviewPlan,
  selectBrowser,
} from './release-visualization-ci.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skill = readFileSync(join(root, 'apps/desktop/resources/cli/ari/SKILL.md'), 'utf8')
const commit = 'd'.repeat(40)

test('capture marker observes the committed React chart and readable error in jsdom', async () => {
  const require = createRequire(join(root, 'package.json'))
  const { JSDOM } = require('jsdom')
  const temporaryParent = realpathSync(tmpdir())
  const dest = mkdtempSync(join(temporaryParent, 'ari-viz-render-fixture-'))
  try {
    const esbuild = resolveEsbuild(root)
    assert.ok(esbuild, 'Existing esbuild is required for the actual render fixture')
    await bundleRenderer(root, esbuild, dest)
    const bundle = readFileSync(join(dest, 'bundle.js'), 'utf8')
    const cases = [
      {
        kind: 'documented',
        type: 'metrics',
        input: {
          version: 1,
          type: 'metrics',
          title: 'Render acceptance',
          items: [{ label: 'Hours', value: 4 }],
        },
      },
      {
        kind: 'historical',
        type: 'timeline',
        input: {
          version: 1,
          type: 'timeline',
          title: 'Wrapped acceptance',
          data: { events: [{ label: 'Start' }] },
        },
      },
      {
        kind: 'error',
        type: 'timeline',
        input: { version: 1, type: 'timeline', title: 'Missing events' },
      },
    ]
    for (const item of cases) {
      const source = JSON.stringify(item.input)
      const dom = new JSDOM(
        `<html><body><div id="ari-layer-root"></div><div id="root"></div><script id="viz-source" type="application/json">${source}</script></body></html>`,
        { runScripts: 'outside-only', pretendToBeVisual: true },
      )
      try {
        dom.window.eval(bundle)
        // createRoot.render alone returns before commit. The capture must not
        // publish a stale false result while the actual chart renders later.
        const marker = readReviewMarker(dom.serialize())
        assertReviewResult(marker, { ...item, id: item.kind, sourceRole: 'after', source })
        assert.equal(
          Boolean(dom.window.document.querySelector('figure.ari-viz')),
          item.kind !== 'error',
        )
      } finally {
        dom.window.close()
      }
    }
  } finally {
    assert.equal(dirname(dest), temporaryParent, 'Only the owned temporary fixture may be removed')
    rmSync(dest, { recursive: true, force: true })
  }
})

test('hosted capture checks out exact PR head with the pinned before source available', () => {
  const workflow = readFileSync(join(root, '.github/workflows/visualization-review.yml'), 'utf8')
  assert.ok(workflow.includes('ref: ${{ github.event.pull_request.head.sha }}'))
  assert.match(workflow, /fetch-depth: 0/)
  assert.match(workflow, /persist-credentials: false/)
  assert.ok(
    workflow.includes('VISUALIZATION_REVIEW_SHA: ${{ github.event.pull_request.head.sha }}'),
  )
  const script = readFileSync(join(root, 'scripts/release-visualization-ci.mjs'), 'utf8')
  assert.match(script, /after !== process.env.VISUALIZATION_REVIEW_SHA/)
})

test('hosted screenshot gate refuses a desktop or relative runner', () => {
  assert.equal(hostedReviewEnv({}), false)
  assert.equal(
    hostedReviewEnv({
      VISUALIZATION_REVIEW_CI: '1',
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'self-hosted',
      RUNNER_TEMP: tmpdir(),
    }),
    false,
  )
  assert.equal(
    hostedReviewEnv({
      VISUALIZATION_REVIEW_CI: '1',
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_TEMP: 'runner',
    }),
    false,
  )
  assert.equal(
    hostedReviewEnv({
      VISUALIZATION_REVIEW_CI: '1',
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      RUNNER_ENVIRONMENT: 'github-hosted',
      RUNNER_TEMP: tmpdir(),
    }),
    true,
  )
})

test('review plan records every type, theme, width and the historical timeline', () => {
  const plan = reviewPlan({ commit, skill })
  assert.equal(plan.captured, false)
  assert.equal(plan.commit, commit)
  assert.equal(plan.desktopWidth, DESKTOP_WIDTH)
  assert.equal(plan.mobileWidth, MOBILE_WIDTH)
  assert.ok(plan.mobileWidth < MOBILE_BREAKPOINT)
  assert.equal(plan.cases.length, VISUAL_TYPES.length * 8 + 8)
  for (const type of VISUAL_TYPES) {
    for (const theme of ['light', 'dark']) {
      for (const width of [DESKTOP_WIDTH, MOBILE_WIDTH]) {
        const item = plan.cases.find(
          (candidate) =>
            candidate.kind === 'documented' &&
            candidate.type === type &&
            candidate.theme === theme &&
            candidate.width === width,
        )
        assert.ok(item, `${type} ${theme} ${width}`)
        assert.equal(item.commit, commit)
        assert.equal(item.themeId, theme === 'light' ? 'porcelain' : 'obsidian')
        assert.equal(JSON.parse(item.source).type, type)
      }
    }
  }
  const historical = plan.cases.find((item) => item.kind === 'historical')
  assert.deepEqual(JSON.parse(historical.source), {
    version: 1,
    type: 'timeline',
    title: 'Release progress',
    data: {
      events: [
        { label: 'v0.2.0', date: '2026-08-30', description: 'Previous release' },
        { label: 'v0.3.13', date: 'in progress', tone: 'warning' },
      ],
    },
  })
  const errorCard = plan.cases.find((item) => item.kind === 'error' && item.theme === 'dark')
  assert.equal(JSON.parse(errorCard.source).type, 'timeline')
  assert.equal(Object.hasOwn(JSON.parse(errorCard.source), 'events'), false)
  for (const type of VISUAL_TYPES) {
    assert.ok(
      plan.cases.some((item) => item.kind === 'stress' && item.type === type),
      `stress ${type}`,
    )
  }
  assert.ok(
    plan.cases.some(
      (item) => item.kind === 'stress' && item.type === 'heatmap' && item.width === MOBILE_WIDTH,
    ),
  )
  assert.throws(
    () => reviewPlan({ commit, skill: '## Inline visualizations\n## Typed tasks\n' }),
    /missing bar/,
  )
  const ids = new Set(plan.cases.map((item) => item.id))
  assert.equal(ids.size, plan.cases.length)
})

test('browser selection stays on unix system paths and does not launch', () => {
  const candidates = chromeCandidates({})
  assert.ok(candidates.length > 0)
  assert.ok(candidates.every((path) => path.startsWith('/usr/bin/')))
  assert.equal(
    selectBrowser(candidates, () => false),
    null,
  )
  assert.equal(
    selectBrowser(['/usr/bin/google-chrome'], (path) => path.endsWith('google-chrome')),
    '/usr/bin/google-chrome',
  )
  const esbuild = resolveEsbuild(root)
  assert.ok(esbuild === null || esbuild.endsWith(`${join('bin', 'esbuild')}`))
  if (esbuild !== null) {
    assert.equal(esbuildApiEntry(esbuild).endsWith(`${join('lib', 'main.js')}`), true)
  }
  assert.throws(() => esbuildApiEntry(join(tmpdir(), 'missing-esbuild')), /JS API is missing/)
  assert.throws(
    () => assertCaptureTools({ chrome: null, esbuild: 'bin' }),
    /Chrome was not downloaded/,
  )
  assert.throws(
    () => assertCaptureTools({ chrome: '/usr/bin/google-chrome', esbuild: null }),
    /could not be resolved/,
  )
})

test('review marker requires a ready chart or a bounded error', () => {
  const chart = `<script id="ari-viz-review" type="application/json">${JSON.stringify({
    ready: true,
    ok: true,
    title: 'Release progress',
    error: '',
    unavailable: false,
    failures: [],
  })}</script>`
  const rendered = {
    id: 'after-historical-timeline-light-1280',
    sourceRole: 'after',
    kind: 'historical',
    type: 'timeline',
    source: JSON.stringify({ title: 'Release progress' }),
  }
  assert.equal(readReviewMarker(chart).title, 'Release progress')
  assert.doesNotThrow(() => assertReviewResult(readReviewMarker(chart), rendered))
  const unavailable = chart
    .replace('"ok":true', '"ok":false')
    .replace('"unavailable":false', '"unavailable":true,"error":"nope"')
  assert.throws(
    () => assertReviewResult(readReviewMarker(unavailable), rendered),
    /Expected a rendered/,
  )
  const named = `<script id="ari-viz-review" type="application/json">${JSON.stringify({
    ready: true,
    ok: false,
    title: '',
    error: 'Timeline charts need events.',
    unavailable: true,
    failures: [],
  })}</script>`
  const errorItem = {
    id: 'after-error-timeline-dark-390',
    sourceRole: 'after',
    kind: 'error',
    type: 'timeline',
    source: '{}',
  }
  assert.doesNotThrow(() => assertReviewResult(readReviewMarker(named), errorItem))
  const generic = named.replace('Timeline charts need events.', 'Invalid input')
  assert.throws(
    () => assertReviewResult(readReviewMarker(generic), errorItem),
    /named missing-events/,
  )
  assert.doesNotThrow(() =>
    assertReviewResult(readReviewMarker(generic), {
      ...rendered,
      sourceRole: 'before',
      kind: 'historical',
    }),
  )
  assert.throws(() => readReviewMarker('<html></html>'), /marker is missing/)
  const crashed = named.replace('"failures":[]', '"failures":["render exploded"]')
  assert.throws(() => assertReviewResult(readReviewMarker(crashed), errorItem), /Renderer failure/)
})

test('paired plan uses the same cases at the pre-fix base and the after head', () => {
  const after = 'a'.repeat(40)
  const plan = pairedReviewPlan({ before: BEFORE_COMMIT, after, skill })
  const single = reviewPlan({ commit: after, skill })
  assert.equal(plan.before, BEFORE_COMMIT)
  assert.equal(plan.after, after)
  assert.equal(plan.captured, false)
  assert.equal(plan.caseCount, single.cases.length * 2)
  assert.equal(plan.cases.length, plan.caseCount)
  for (const item of single.cases) {
    const before = plan.cases.find((candidate) => candidate.id === `before-${item.id}`)
    const afterCase = plan.cases.find((candidate) => candidate.id === `after-${item.id}`)
    assert.ok(before)
    assert.ok(afterCase)
    assert.equal(before.source, item.source)
    assert.equal(afterCase.source, item.source)
    assert.equal(before.commit, BEFORE_COMMIT)
    assert.equal(afterCase.commit, after)
    assert.equal(before.theme, afterCase.theme)
    assert.equal(before.width, afterCase.width)
    assert.equal(before.kind, afterCase.kind)
    assert.equal(before.sourceRole, 'before')
    assert.equal(afterCase.sourceRole, 'after')
  }
})

test('extracted base parser has no data-wrapper flattener', async () => {
  const dest = mkdtempSync(join(tmpdir(), 'ari-viz-before-'))
  try {
    await extractSource(root, BEFORE_COMMIT, dest)
    const beforeParser = readFileSync(join(dest, 'packages/contracts/src/visualization.ts'), 'utf8')
    const afterParser = readFileSync(join(root, 'packages/contracts/src/visualization.ts'), 'utf8')
    const marker = 'The data field must be one object of chart fields.'
    assert.equal(beforeParser.includes('prepareVisualization'), false)
    assert.equal(beforeParser.includes(marker), false)
    assert.equal(afterParser.includes(marker), true)
    const esbuild = resolveEsbuild(root)
    if (esbuild === null) return
    const bundleDir = join(dest, 'bundles')
    await bundleRenderer(root, esbuild, join(bundleDir, 'before'), {
      sourceRoot: dest,
      outfile: 'bundle.js',
      entryName: 'before.tsx',
    })
    await bundleRenderer(root, esbuild, join(bundleDir, 'after'), {
      sourceRoot: root,
      outfile: 'bundle.js',
      entryName: 'after.tsx',
    })
    const beforeBundle = readFileSync(join(bundleDir, 'before', 'bundle.js'), 'utf8')
    const afterBundle = readFileSync(join(bundleDir, 'after', 'bundle.js'), 'utf8')
    assert.equal(beforeBundle.includes(marker), false)
    assert.equal(afterBundle.includes(marker), true)
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
})
