import { describe, expect, it } from 'vitest'
import { fakeHttp } from './__fixtures__/fake-http'
import type { OcPromptInput } from './wire'
import { permissionRules, splitModelId } from './wire'
import { answersV1, questionsV1, WireV1 } from './wire-v1'
import { answersV2, questionsV2, WireV2 } from './wire-v2'

const DIR = 'D:\\work'
const input: OcPromptInput = {
  text: 'hello',
  files: [{ url: 'data:image/png;base64,AAAA', mime: 'image/png', name: 'a.png' }],
  model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet' },
  variant: 'high',
}

describe('shared helpers', () => {
  it('splits provider/model ids at the first slash only', () => {
    expect(splitModelId('openrouter/anthropic/claude')).toEqual({
      providerID: 'openrouter',
      modelID: 'anthropic/claude',
    })
    expect(splitModelId('default')).toBeNull()
    expect(splitModelId('bare')).toBeNull()
    expect(splitModelId(null)).toBeNull()
  })

  it('maps Ari modes onto rules where the last match wins', () => {
    expect(permissionRules('full', 'bash')).toEqual([{ action: '*', effect: 'allow' }])
    expect(permissionRules('allow-edits', 'shell')).toEqual([
      { action: 'edit', effect: 'allow' },
      { action: 'shell', effect: 'ask' },
      { action: 'webfetch', effect: 'ask' },
    ])
    expect(permissionRules('ask', 'bash')[0]).toEqual({ action: 'edit', effect: 'ask' })
  })
})

describe('classic wire', () => {
  it('creates sessions with permission rules in the project directory', async () => {
    const { http, requests } = fakeHttp({ 'POST /session': { id: 'ses_1' } })
    expect(await new WireV1(http).createSession(DIR, 'allow-edits')).toBe('ses_1')
    expect(requests[0]).toMatchObject({
      path: '/session',
      headers: { 'x-opencode-directory': encodeURIComponent(DIR) },
      body: {
        permission: [
          { permission: 'edit', pattern: '*', action: 'allow' },
          { permission: 'bash', pattern: '*', action: 'ask' },
          { permission: 'webfetch', pattern: '*', action: 'ask' },
        ],
      },
    })
  })

  it('prompts asynchronously with parts, model and variant', async () => {
    const { http, requests } = fakeHttp()
    await new WireV1(http).prompt('ses_1', DIR, input)
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/session/ses_1/prompt_async',
      body: {
        parts: [
          { type: 'text', text: 'hello' },
          { type: 'file', mime: 'image/png', url: 'data:image/png;base64,AAAA', filename: 'a.png' },
        ],
        model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet' },
        variant: 'high',
      },
    })
  })

  it('answers permissions and questions on their own routes', async () => {
    const { http, requests } = fakeHttp()
    const wire = new WireV1(http)
    await wire.replyPermission('ses_1', 'per_1', DIR, 'always')
    const questions = questionsV1([
      { question: 'Q1', header: 'H', options: [{ label: 'A', description: '' }] },
      { question: 'Q2', header: 'Q2', options: [{ label: 'X' }, { label: 'Y' }], multiple: true },
    ])
    await wire.replyQuestion('ses_1', 'que_1', DIR, { kind: 'v1' }, questions, {
      '0': 'A',
      '1': ['X', 'Y'],
    })
    await wire.rejectQuestion('ses_1', 'que_2', DIR)
    await wire.interrupt('ses_1', DIR)
    expect(requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ['POST', '/permission/per_1/reply', { reply: 'always' }],
      ['POST', '/question/que_1/reply', { answers: [['A'], ['X', 'Y']] }],
      ['POST', '/question/que_2/reject', undefined],
      ['POST', '/session/ses_1/abort', undefined],
    ])
    expect(answersV1(questions, { Q1: 'A' })).toEqual([['A'], []])
  })

  it('treats a missing session as absent so a stale resume starts fresh', async () => {
    const { http } = fakeHttp({
      'GET /session/ses_gone': new Response('{}', { status: 404 }),
      'GET /session/ses_here': { id: 'ses_here' },
    })
    const wire = new WireV1(http)
    expect(await wire.sessionExists('ses_gone', DIR)).toBe(false)
    expect(await wire.sessionExists('ses_here', DIR)).toBe(true)
  })

  it('reads the catalog with ACP-compatible ids and variants as efforts', async () => {
    const { http } = fakeHttp({
      'GET /config/providers': {
        providers: [
          {
            id: 'openrouter',
            name: 'OpenRouter',
            models: {
              'b/m': {
                id: 'b/m',
                name: 'Beta',
                limit: { context: 200000 },
                variants: { low: {}, high: {} },
              },
              'a/m': { id: 'a/m', name: 'Alpha', limit: { context: 0 } },
            },
          },
        ],
        default: { openrouter: 'a/m' },
      },
      'GET /config': { model: 'openrouter/b/m' },
      'GET /command': [{ name: 'review', description: 'Review', source: 'command' }],
    })
    const wire = new WireV1(http)
    const catalog = await wire.catalog(DIR)
    expect(catalog.defaultModelId).toBe('openrouter/b/m')
    expect(catalog.models.map((m) => [m.id, m.label, m.contextHint ?? null])).toEqual([
      ['openrouter/a/m', 'OpenRouter/Alpha', null],
      ['openrouter/b/m', 'OpenRouter/Beta', '200k'],
    ])
    expect(catalog.models[1]?.efforts?.map((e) => e.id)).toEqual(['low', 'high', 'default'])
    expect(await wire.commands(DIR)).toEqual([
      { name: 'review', description: 'Review', source: 'command' },
    ])
  })
})

describe('OpenCode 2 wire', () => {
  it('creates sessions at a location with permission rules', async () => {
    const { http, requests } = fakeHttp({ 'POST /api/session': { data: { id: 'ses_2' } } })
    expect(await new WireV2(http, 0).createSession(DIR, 'full')).toBe('ses_2')
    expect(requests[0]?.body).toEqual({
      location: { directory: DIR },
      permissions: [{ action: '*', resource: '*', effect: 'allow' }],
    })
  })

  it('selects the model before prompting and steers without touching it', async () => {
    const { http, requests } = fakeHttp({ 'POST /api/session/ses_2/prompt': { data: {} } })
    const wire = new WireV2(http, 0)
    await wire.prompt('ses_2', DIR, input)
    await wire.steer('ses_2', DIR, { ...input, model: null, variant: null, files: [] })
    expect(requests.map((r) => [r.path, r.body])).toEqual([
      [
        '/api/session/ses_2/model',
        { model: { id: 'anthropic/claude-sonnet', providerID: 'openrouter', variant: 'high' } },
      ],
      [
        '/api/session/ses_2/prompt',
        {
          text: 'hello',
          files: [{ uri: 'data:image/png;base64,AAAA', name: 'a.png' }],
          delivery: 'steer',
        },
      ],
      ['/api/session/ses_2/prompt', { text: 'hello', delivery: 'steer' }],
    ])
  })

  it('answers permissions, forms and the shell environment per session', async () => {
    const { http, requests } = fakeHttp()
    const wire = new WireV2(http, 0)
    const { questions, fields } = questionsV2([
      { key: 'db', type: 'string', title: 'DB', options: [{ value: 'pg', label: 'Postgres' }] },
      { key: 'tags', type: 'multiselect', options: [{ value: 'a', label: 'A' }] },
      { key: 'ok', type: 'boolean', title: 'OK?' },
      { key: 'port', type: 'integer', title: 'Port' },
      { key: 'secret', type: 'string', hidden: true },
    ])
    expect(questions.map((q) => q.id)).toEqual(['db', 'tags', 'ok', 'port'])
    await wire.replyPermission('ses_2', 'per_2', DIR, 'reject')
    await wire.replyQuestion('ses_2', 'frm_1', DIR, { kind: 'v2', fields }, questions, {
      db: 'pg',
      tags: ['a'],
      ok: 'true',
      port: '8080',
    })
    await wire.rejectQuestion('ses_2', 'frm_2', DIR)
    await wire.setEnvironment('ses_2', DIR, { ARI_SESSION_ID: 's' })
    await wire.interrupt('ses_2', DIR)
    expect(requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ['POST', '/api/session/ses_2/permission/per_2/reply', { decision: 'reject' }],
      [
        'POST',
        '/api/session/ses_2/form/frm_1/reply',
        { answer: { db: 'pg', tags: ['a'], ok: true, port: 8080 } },
      ],
      ['DELETE', '/api/session/ses_2/form/frm_2', undefined],
      ['PUT', '/api/session/ses_2/environment', { variables: { ARI_SESSION_ID: 's' } }],
      ['POST', '/api/session/ses_2/interrupt', undefined],
    ])
    expect(answersV2({ kind: 'v2', fields }, questions, { port: 'abc', ok: 'no' })).toEqual({
      ok: false,
    })
  })

  it('reads models with provider names, variants and the default model', async () => {
    const { http } = fakeHttp({
      'GET /api/model': {
        location: { directory: DIR },
        data: [
          {
            id: 'big',
            providerID: 'opencode',
            name: 'Big',
            enabled: true,
            variants: [{ id: 'none' }, { id: 'max' }],
            limit: { context: 1048576, output: 1 },
          },
          {
            id: 'off',
            providerID: 'opencode',
            name: 'Off',
            enabled: false,
            variants: [],
            limit: {},
          },
        ],
      },
      'GET /api/provider': { data: [{ id: 'opencode', name: 'OpenCode' }] },
      'GET /api/model/default': { data: { id: 'big', providerID: 'opencode' } },
    })
    const catalog = await new WireV2(http, 0).catalog(DIR)
    expect(catalog.models).toEqual([
      {
        id: 'opencode/big',
        label: 'OpenCode/Big',
        contextHint: '1m',
        efforts: [
          { id: 'none', label: 'None' },
          { id: 'max', label: 'Max' },
          { id: 'default', label: 'Default', current: true },
        ],
        effortsSource: 'agent',
      },
    ])
    expect(catalog.defaultModelId).toBe('opencode/big')
  })
})
