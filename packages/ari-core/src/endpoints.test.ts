import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EndpointStore, type EndpointModel } from './endpoints'

async function store(): Promise<{ dir: string; store: EndpointStore; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'ari-endpoints-'))
  return {
    dir,
    store: new EndpointStore({ dir }),
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  }
}

const BASE = {
  id: 'ep-1',
  name: 'Local',
  baseUrl: 'http://localhost:8080/v1',
  flavor: 'openai-chat' as const,
  model: 'default-model',
  headers: {},
}

const model = (id: string, source: EndpointModel['source'] = 'discovered'): EndpointModel => ({
  id,
  label: id,
  contextWindow: null,
  source,
})

describe('EndpointStore multi-model support', () => {
  it('always exposes the default model in the model list', async () => {
    const { store: s, cleanup } = await store()
    try {
      const saved = await s.upsert(BASE)
      expect(saved.models).toEqual([
        { id: 'default-model', label: 'default-model', contextWindow: null, source: 'manual' },
      ])
    } finally {
      await cleanup()
    }
  })

  it('stores a discovered model list and keeps the default in it', async () => {
    const { store: s, cleanup } = await store()
    try {
      await s.upsert(BASE)
      const updated = await s.setModels('ep-1', [model('a'), model('b')])
      expect(updated?.models.map((m) => m.id).sort()).toEqual(['a', 'b', 'default-model'])
      expect(updated?.model).toBe('default-model')
    } finally {
      await cleanup()
    }
  })

  it('keeps manually-added models across a discovery refresh', async () => {
    const { store: s, cleanup } = await store()
    try {
      await s.upsert(BASE)
      await s.setModels('ep-1', [model('kept', 'manual'), model('gone')])
      const refreshed = await s.setModels('ep-1', [model('gone'), model('new')])
      const ids = refreshed?.models.map((m) => m.id) ?? []
      expect(ids).toContain('kept')
      expect(ids).toContain('new')
      expect(ids).toContain('gone')
    } finally {
      await cleanup()
    }
  })

  it('repoints the default model when it vanishes from the list', async () => {
    const { store: s, cleanup } = await store()
    try {
      await s.upsert({ ...BASE, models: [model('old-default', 'discovered')], model: 'old-default' })
      const updated = await s.setModels('ep-1', [model('replacement')])
      expect(updated?.model).toBe('replacement')
      expect(updated?.models.map((m) => m.id)).toEqual(['replacement'])
    } finally {
      await cleanup()
    }
  })

  it('returns null when setting models on an unknown endpoint', async () => {
    const { store: s, cleanup } = await store()
    try {
      expect(await s.setModels('nope', [model('a')])).toBeNull()
    } finally {
      await cleanup()
    }
  })

  it('backfills models for configs written before multi-model support', async () => {
    const { dir, store: s, cleanup } = await store()
    try {
      await writeFile(
        join(dir, 'endpoints.json'),
        JSON.stringify([
          {
            id: 'legacy',
            name: 'Legacy',
            baseUrl: 'http://legacy/v1',
            flavor: 'openai-chat',
            model: 'only-model',
            apiKeyCipher: null,
            headers: {},
          },
        ]),
        'utf8',
      )
      const loaded = await s.load()
      expect(loaded[0]?.models).toEqual([
        { id: 'only-model', label: 'only-model', contextWindow: null, source: 'manual' },
      ])
    } finally {
      await cleanup()
    }
  })

  it('keeps the stored model list when upsert omits it', async () => {
    const { store: s, cleanup } = await store()
    try {
      await s.upsert(BASE)
      await s.setModels('ep-1', [model('a')])
      const renamed = await s.upsert({ ...BASE, name: 'Renamed' })
      expect(renamed.name).toBe('Renamed')
      expect(renamed.models.map((m) => m.id).sort()).toEqual(['a', 'default-model'])
    } finally {
      await cleanup()
    }
  })

  it('persists model lists to disk atomically', async () => {
    const { dir, store: s, cleanup } = await store()
    try {
      await s.upsert(BASE)
      await s.setModels('ep-1', [model('persisted')])
      const raw = JSON.parse(await readFile(join(dir, 'endpoints.json'), 'utf8')) as unknown[]
      expect(JSON.stringify(raw)).toContain('persisted')
    } finally {
      await cleanup()
    }
  })
})
