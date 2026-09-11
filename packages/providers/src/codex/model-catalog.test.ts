import { describe, expect, it, vi } from 'vitest'
import { probeCodexModelCatalog } from './model-catalog'

describe('probeCodexModelCatalog', () => {
  it('pages through picker-visible models and reads the default model efforts', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({ userAgent: 'codex/test' })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'row-astra',
            model: 'gpt-6-astra',
            displayName: 'GPT-6 Astra',
            isDefault: true,
            defaultReasoningEffort: 'high',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Faster' },
              { reasoningEffort: 'high', description: 'Deeper' },
            ],
          },
          { model: 'hidden-model', hidden: true },
        ],
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({
        data: [{ model: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra' }],
        nextCursor: null,
      })
    const shutdown = vi.fn().mockResolvedValue(undefined)

    const catalog = await probeCodexModelCatalog('/bin/codex', '/workspace', () => ({
      request,
      shutdown,
    }))

    expect(request).toHaveBeenNthCalledWith(1, 'initialize', expect.anything(), 15_000)
    expect(request).toHaveBeenNthCalledWith(2, 'model/list', expect.anything(), 15_000)
    expect(request).toHaveBeenNthCalledWith(3, 'model/list', expect.anything(), 15_000)
    expect(request.mock.calls[2]?.[1]).toMatchObject({ cursor: 'next' })
    expect(catalog.models).toEqual([
      { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra' },
    ])
    expect(catalog.efforts).toEqual({
      currentId: 'high',
      options: [
        { id: 'low', label: 'Low', description: 'Faster' },
        { id: 'high', label: 'High', description: 'Deeper' },
      ],
    })
    expect(shutdown).toHaveBeenCalledOnce()
  })

  it('always shuts down when the installed CLI does not support model/list', async () => {
    const shutdown = vi.fn().mockResolvedValue(undefined)
    await expect(
      probeCodexModelCatalog('/bin/codex', '/workspace', () => ({
        request: vi
          .fn()
          .mockResolvedValueOnce({})
          .mockRejectedValueOnce(new Error('unknown method')),
        shutdown,
      })),
    ).rejects.toThrow('unknown method')
    expect(shutdown).toHaveBeenCalledOnce()
  })
})
