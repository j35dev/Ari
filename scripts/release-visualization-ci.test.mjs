import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
  bundleRenderer,
  chromeCandidates,
  extractSource,
  hostedReviewEnv,
  pairedReviewPlan,
  resolveEsbuild,
  reviewPlan,
  selectBrowser,
} from './release-visualization-ci.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skill = readFileSync(join(root, 'apps/desktop/resources/cli/ari/SKILL.md'), 'utf8')
const commit = 'd'.repeat(40)

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
  assert.equal(plan.cases.length, VISUAL_TYPES.length * 4 + 6 * 4 + 4 + 4)
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
  assert.ok(
    plan.cases.some(
      (item) => item.kind === 'stress' && item.type === 'heatmap' && item.width === MOBILE_WIDTH,
    ),
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
