import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  DESKTOP_WIDTH,
  MOBILE_BREAKPOINT,
  MOBILE_WIDTH,
  VISUAL_TYPES,
  chromeCandidates,
  hostedReviewEnv,
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
