// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { TriageGitHub, caseMarker } from './github'
import { HostingApi, HostingError } from '../hosting-api'
import { SourceControlConnections } from '../source-control-connections'
import { aesGcmSecretBox } from '../secret-box'

describe('triage GitHub publication', () => {
  it('preserves binary bytes and modes and resumes a branch creation whose acknowledgement was lost', async () => {
    const api = new HostingApi(
      new SourceControlConnections('unused-test-path', aesGcmSecretBox(Buffer.alloc(32))),
    )
    const github = new TriageGitHub(api)
    const bytes = Buffer.from([0, 255, 128, 65])
    const blob = createHash('sha1')
      .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
      .digest('hex')
    let branch: string | null = null,
      published = false,
      receipt: string | null = null
    const request = vi.spyOn(api, 'request').mockImplementation(async (_host, path, options) => {
      const body = options?.body as Record<string, unknown> | undefined
      if (path === '/repos/contributor/Ari')
        return { full_name: 'contributor/Ari', parent: { full_name: 'j35dev/Ari' } }
      if (path.endsWith(`/git/commits/${'a'.repeat(40)}`)) return { tree: { sha: 'b'.repeat(40) } }
      if (path.endsWith('/git/blobs')) {
        expect(Buffer.from(body!.content as string, 'base64')).toEqual(bytes)
        return { sha: blob }
      }
      if (path.endsWith('/git/trees')) {
        expect(body!.tree).toEqual([
          { path: 'binary.png', mode: '100755', type: 'blob', sha: blob },
          { path: 'deleted.txt', mode: '100644', type: 'blob', sha: null },
        ])
        return { sha: 'c'.repeat(40) }
      }
      if (path.endsWith('/git/commits')) return { sha: 'd'.repeat(40) }
      if (path.includes('/git/ref/heads/')) {
        if (!branch) throw new HostingError('failed', 'Not found', 404)
        return { object: { sha: branch } }
      }
      if (path.endsWith('/git/refs')) {
        branch = body!.sha as string
        throw new Error('Lost branch acknowledgement')
      }
      if (path.includes('/pulls?'))
        return published
          ? [
              {
                number: 7,
                html_url: 'https://github.com/j35dev/Ari/pull/7',
                body: caseMarker('triage_test'),
              },
            ]
          : []
      if (path.endsWith('/pulls')) {
        expect(body).toMatchObject({
          head: 'contributor:ari-triage/test',
          base: 'main',
          draft: true,
        })
        published = true
        return { number: 7, html_url: 'https://github.com/j35dev/Ari/pull/7' }
      }
      throw new Error(`Unexpected API path ${path}`)
    })
    const input = {
      id: 'triage_test',
      account: 'contributor',
      branch: 'ari-triage/test',
      base: 'a'.repeat(40),
      expectedTree: 'c'.repeat(40),
      draft: { title: 'Fix', body: 'Verified fix' },
      files: [
        { path: 'binary.png', mode: '100755', content: bytes },
        { path: 'deleted.txt', mode: '100644', content: null },
      ],
      commit: null,
      onCommit: async (sha: string) => {
        receipt = sha
      },
    }
    await expect(github.createPr(input)).rejects.toThrow('Lost branch acknowledgement')
    expect(receipt).toBe('d'.repeat(40))
    expect((await github.createPr({ ...input, commit: receipt })).number).toBe(7)
    expect((await github.createPr({ ...input, commit: receipt })).number).toBe(7)
    expect(request.mock.calls.filter(([, path]) => path.endsWith('/git/blobs'))).toHaveLength(1)
    expect(
      request.mock.calls.filter(
        ([, path, options]) => path.endsWith('/pulls') && options?.method === 'POST',
      ),
    ).toHaveLength(1)
  })
  it('does not create a ref when the upload differs from the verified tree', async () => {
    const api = new HostingApi(
      new SourceControlConnections('unused-test-path', aesGcmSecretBox(Buffer.alloc(32))),
    )
    const github = new TriageGitHub(api)
    const request = vi.spyOn(api, 'request').mockImplementation(async (_host, path) => {
      if (path.includes('/git/commits/')) return { tree: { sha: 'b'.repeat(40) } }
      if (path.endsWith('/git/trees')) return { sha: 'e'.repeat(40) }
      throw new Error(`Unexpected API path ${path}`)
    })
    await expect(
      github.createPr({
        id: 'test',
        account: 'j35dev',
        branch: 'test',
        base: 'a'.repeat(40),
        expectedTree: 'c'.repeat(40),
        draft: { title: 'Fix', body: 'verified' },
        files: [],
        commit: null,
        onCommit: async () => undefined,
      }),
    ).rejects.toThrow('does not match')
    expect(
      request.mock.calls.some(([, path]) => path.endsWith('/git/refs') || path.endsWith('/pulls')),
    ).toBe(false)
  })
})
