import { describe, expect, it, vi } from 'vitest'
import { AppServerConnection } from './appserver-connection'
import { probeCodexModelCatalog } from './model-catalog'

/** Transport double that answers the handshake and an empty model page. */
function fakeTransport(): { request: ReturnType<typeof vi.fn>; shutdown: ReturnType<typeof vi.fn> } {
  return {
    request: vi
      .fn()
      .mockResolvedValueOnce({ userAgent: 'codex/test' })
      .mockResolvedValueOnce({ data: [], nextCursor: null }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

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

    const catalog = await probeCodexModelCatalog('/bin/codex', '/workspace', {
      start: () => ({ request, shutdown }),
    })

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
      probeCodexModelCatalog('/bin/codex', '/workspace', {
        start: () => ({
          request: vi
            .fn()
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error('unknown method')),
          shutdown,
        }),
      }),
    ).rejects.toThrow('unknown method')
    expect(shutdown).toHaveBeenCalledOnce()
  })

  it('starts the CLI with the enriched environment detection used to find it', async () => {
    const start = vi
      .spyOn(AppServerConnection, 'start')
      .mockImplementation(() => fakeTransport() as unknown as AppServerConnection)
    try {
      const env = { PATH: '/opt/volta/bin:/usr/bin' }
      await probeCodexModelCatalog('/bin/codex', '/workspace', { env })
      expect(start).toHaveBeenCalledWith(
        expect.objectContaining({ binaryPath: '/bin/codex', cwd: '/workspace', env }),
      )
    } finally {
      start.mockRestore()
    }
  })

  it('inherits the host environment when the caller has no PATH override', async () => {
    const start = vi
      .spyOn(AppServerConnection, 'start')
      .mockImplementation(() => fakeTransport() as unknown as AppServerConnection)
    try {
      await probeCodexModelCatalog('/bin/codex', '/workspace')
      // An empty env object would spawn the child without PATH at all.
      expect(start.mock.calls[0]?.[0]).not.toHaveProperty('env')
    } finally {
      start.mockRestore()
    }
  })
})
