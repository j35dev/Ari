// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import type { TriageContext } from '@ari/contracts/triage'
import { triageRpcParams } from '@ari/contracts/triage'
import { TriageCaseStore } from './case-store'
import { TriageLog, redact, collectContext } from './diagnostics'
import { TriageSource } from './source'
import { TriageService } from './service'
import { TriageGitHub } from './github'
import { HostingApi, HostingError } from '../hosting-api'
import { SourceControlConnections } from '../source-control-connections'
import { aesGcmSecretBox } from '../secret-box'

const agent = {
  driverKind: 'codex' as const,
  modelId: null,
  effort: 'high',
  permissionMode: 'ask' as const,
}
const draft = { title: 'Fix session switching', body: 'Reproduction and evidence.' }
const facts: TriageContext = {
  version: 1,
  appVersion: '0.3.22',
  buildCommit: null,
  profile: 'Ari Dev',
  machine: 'Test PC',
  platform: process.platform,
  arch: process.arch,
  osRelease: 'test',
  nodeVersion: process.versions.node,
  electronVersion: null,
  collectedAt: Date.now(),
  providers: [],
  logs: 'approved diagnostic',
  exclusions: ['Prompts'],
}
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ari-triage-test-'))
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim()
}
async function fixture() {
  const upstream = join(root, 'upstream')
  await mkdir(upstream)
  git(upstream, ['init', '-b', 'main'])
  await writeFile(join(upstream, 'file.txt'), 'original\n')
  git(upstream, ['add', '.'])
  git(upstream, [
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.test',
    'commit',
    '-m',
    'fixture',
  ])
  const store = new TriageCaseStore(join(root, 'triage'))
  const source = new TriageSource(store.root, upstream)
  const api = new HostingApi(
    new SourceControlConnections(join(root, 'connections.json'), aesGcmSecretBox(Buffer.alloc(32))),
  )
  const github = new TriageGitHub(api)
  vi.spyOn(github, 'identity').mockResolvedValue('contributor')
  const prompt = vi.fn(async (_sessionId: string, _text: string) => undefined)
  const checks = vi.fn(async () => ({ passed: true, output: 'Checks passed' }))
  let sessionCount = 0
  const service = new TriageService({
    store,
    source,
    github,
    context: async () => facts,
    project: async () => 'support-project',
    session: async () => (sessionCount++ ? 'triage-session-2' : 'triage-session'),
    prompt,
    busy: () => false,
    checks,
  })
  return { store, source, github, service, prompt, checks, upstream }
}

describe('triage evidence and persistence', () => {
  it('removes credential formats and private home paths without removing useful errors', () => {
    const input =
      'Authorization: Bearer secret-value\napi_key="unusual secret"\npassword=private\nhttps://user:pass@example.test\nC:\\Users\\Private\\project\\app.ts\n/home/private/project/app.ts\nError: session timed out'
    const clean = redact(input)
    expect(clean).not.toMatch(
      /secret-value|unusual secret|=private|user:pass|Users\\Private|home\/private/,
    )
    expect(clean).toContain('Error: session timed out')
    expect(redact(clean)).toBe(clean)
    const cli = createRequire(import.meta.url)('../../../resources/cli/triage.cjs') as {
      redact: (input: string) => string
    }
    expect(cli.redact(input)).toBe(clean)
  })
  it('bounds persisted logs and excludes old messages', async () => {
    const path = join(root, 'logs.jsonl')
    await writeFile(path, JSON.stringify({ at: 1, message: 'old' }) + '\n')
    const log = new TriageLog(path)
    log.record('renderer', 'token=private session timed out')
    const context = await collectContext({
      appVersion: 'test',
      buildCommit: null,
      profile: 'Ari',
      providers: [],
      log,
    })
    expect(context.logs).not.toContain('"old"')
    expect(context.logs).not.toContain('private')
    expect(context.exclusions).toContain('Prompts and conversation history')
    for (let i = 0; i < 140; i++) log.record('test', 'x'.repeat(8000))
    await log.flush()
    expect(Buffer.byteLength(await readFile(path, 'utf8'))).toBeLessThanOrEqual(1_048_576)
  })
  it('rejects traversal and ignores damaged cases without deleting them', async () => {
    const store = new TriageCaseStore(root)
    const item = await store.create('Ari freezes', facts)
    await writeFile(join(root, 'cases', `triage_${'a'.repeat(32)}.json`), '{bad')
    expect((await store.list()).map((c) => c.id)).toEqual([item.case.id])
    await expect(store.get('../secrets')).rejects.toThrow()
    expect(
      triageRpcParams['triage.start'].safeParse({
        id: item.case.id,
        mode: 'investigate',
        agent,
        includeLogs: true,
        path: '/private',
      }).success,
    ).toBe(false)
  })
  it('rejects an agent draft linked outside its workspace', async () => {
    const store = new TriageCaseStore(root),
      item = await store.create('Bug', facts)
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(
      outside,
      join(store.directory(item.case.id), 'issue-draft.json'),
      process.platform === 'win32' ? 'junction' : 'dir',
    )
    await expect(store.artifact(item.case.id, 'issue-draft.json')).rejects.toThrow('outside')
  })
})

describe('triage source and session lifecycle', () => {
  it('retains the mode when a fix deletes an executable file', async () => {
    const f = await fixture()
    await writeFile(join(f.upstream, 'script.sh'), '#!/bin/sh\n')
    git(f.upstream, ['add', 'script.sh'])
    git(f.upstream, ['update-index', '--chmod=+x', 'script.sh'])
    git(f.upstream, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '-m',
      'executable fixture',
    ])
    const initial = await f.service.prepare('Remove a broken script')
    const started = await f.service.start(initial.case.id, 'fix', agent, false)
    const path = join(f.store.directory(initial.case.id), 'fix')
    await rm(join(path, 'script.sh'))
    const snapshot = await f.source.snapshot(f.store.directory(initial.case.id), started.case)
    expect(await f.source.changes(path, started.case.fixBase!, snapshot.commit)).toEqual([
      { path: 'script.sh', mode: '100755', blob: null },
    ])
  })
  it('keeps Ari Core context and drafts inside the fix workspace and out of Git', async () => {
    const f = await fixture(),
      initial = await f.service.prepare('Ari freezes')
    const started = await f.service.start(
      initial.case.id,
      'fix',
      { ...agent, driverKind: 'ari-core' },
      false,
    )
    const path = join(f.store.directory(initial.case.id), 'fix')
    expect(await readFile(join(path, '.ari-triage-context.json'), 'utf8')).toContain('"logs": ""')
    expect(await readFile(join(path, '.ari-triage-playbook.md'), 'utf8')).toContain(
      path.replaceAll('\\', '\\\\'),
    )
    await writeFile(join(path, '.ari-triage-pr.json'), JSON.stringify(draft))
    expect((await f.service.refreshDraft(initial.case.id, 'pr')).prDraft).toEqual(draft)
    expect(git(path, ['status', '--porcelain'])).toBe('')
    expect(started.case.fixAgent?.driverKind).toBe('ari-core')
  })
  it('refuses to publish support metadata even if an agent force-committed it', async () => {
    const f = await fixture(),
      initial = await f.service.prepare('Ari freezes')
    await f.service.start(initial.case.id, 'fix', agent, false)
    const path = join(f.store.directory(initial.case.id), 'fix')
    git(path, ['add', '-f', '.ari-triage-context.json'])
    git(path, [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '-m',
      'force metadata',
    ])
    const verified = await f.service.verify(initial.case.id)
    const publish = vi.spyOn(f.github, 'createPr')
    await expect(
      f.service.publishPr(initial.case.id, draft, verified.verification!.revision, 'contributor'),
    ).rejects.toThrow('support files cannot be published')
    expect(publish).not.toHaveBeenCalled()
  })
  it('can switch agents without losing the case or widening its shared context', async () => {
    const f = await fixture(),
      initial = await f.service.prepare('Ari freezes')
    await f.service.start(initial.case.id, 'investigate', agent, false)
    const next = await f.service.start(
      initial.case.id,
      'investigate',
      { ...agent, driverKind: 'claude' },
      false,
    )
    expect(next.case.investigationSessionId).toBe('triage-session-2')
    expect(next.case.id).toBe(initial.case.id)
    expect(f.prompt).toHaveBeenCalledTimes(2)
    expect(
      JSON.parse(await readFile(join(f.store.directory(initial.case.id), 'context.json'), 'utf8'))
        .logs,
    ).toBe('')
  })
  it('recovers a deleted session while preserving its diagnostic case', async () => {
    const f = await fixture(),
      initial = await f.service.prepare('Ari freezes')
    await f.service.start(initial.case.id, 'investigate', agent, false)
    const resumed = new TriageService({ ...f.service.deps, exists: async () => false })
    const next = await resumed.start(initial.case.id, 'investigate', agent, false)
    expect(next.case.investigationSessionId).toBe('triage-session-2')
    expect(next.case.description).toBe(initial.case.description)
  })
  it('starts without a user project, matches a recorded commit, and only writes selected diagnostics', async () => {
    const f = await fixture()
    const snapshot = await f.store.create('Ari freezes', {
      ...facts,
      buildCommit: git(f.upstream, ['rev-parse', 'HEAD']),
    })
    const started = await f.service.start(snapshot.case.id, 'investigate', agent, false)
    expect(started.case.source?.match).toBe('exact')
    expect(started.case.investigationSessionId).toBe('triage-session')
    expect(
      JSON.parse(await readFile(join(f.store.directory(snapshot.case.id), 'context.json'), 'utf8'))
        .logs,
    ).toBe('')
    expect(f.prompt).toHaveBeenCalledOnce()
    await f.service.start(snapshot.case.id, 'investigate', agent, true)
    expect(f.prompt).toHaveBeenCalledOnce()
    expect(git(f.upstream, ['status', '--porcelain'])).toBe('')
  })
  it('continues report-only when source is unavailable', async () => {
    const f = await fixture(),
      snapshot = await f.service.prepare('Ari freezes')
    vi.spyOn(f.source, 'investigation').mockRejectedValue(new Error('Offline'))
    const result = await f.service.start(snapshot.case.id, 'investigate', agent, false)
    expect(result.case.sourceError).toBe('Offline')
    expect(
      await readFile(join(f.store.directory(snapshot.case.id), '.ari-triage-playbook.md'), 'utf8'),
    ).toContain('continue report-only')
  })
  it('preserves staged state and rejects verification that changed the source', async () => {
    const f = await fixture(),
      initial = await f.service.prepare('Ari freezes')
    const result = await f.service.start(initial.case.id, 'fix', agent, true)
    const path = join(f.store.directory(result.case.id), 'fix')
    await writeFile(join(path, 'file.txt'), 'fixed\n')
    git(path, ['add', 'file.txt'])
    const before = git(path, ['diff', '--cached'])
    f.checks.mockImplementation(async () => {
      await writeFile(join(path, 'file.txt'), 'changed during tests\n')
      return { passed: true, output: 'pass' }
    })
    const checked = await f.service.verify(result.case.id)
    expect(checked.verification?.passed).toBe(false)
    expect(checked.verification?.output).toContain('changed during verification')
    expect(git(path, ['diff', '--cached'])).toBe(before)
    await expect(
      f.service.publishPr(result.case.id, draft, checked.verification!.revision, 'contributor'),
    ).rejects.toThrow('Verify and review')
  })
  it('requires verification of current changes, not an older tested tree', async () => {
    const f = await fixture(),
      initial = await f.service.prepare('Ari freezes')
    const result = await f.service.start(initial.case.id, 'fix', agent, false)
    const path = join(f.store.directory(result.case.id), 'fix')
    await writeFile(join(path, 'file.txt'), 'fixed\n')
    const verified = await f.service.verify(result.case.id)
    expect((await f.service.diff(result.case.id)).verificationCurrent).toBe(true)
    await writeFile(join(path, 'new-file.txt'), 'later edit')
    expect((await f.service.diff(result.case.id)).verificationCurrent).toBe(false)
    await expect(
      f.service.publishPr(result.case.id, draft, verified.verification!.revision, 'contributor'),
    ).rejects.toThrow('Verify and review')
  })
})

describe('triage issue publication', () => {
  it('allows editing a PR draft after a lost acknowledgement without changing its verified commit', async () => {
    const f = await fixture(),
      initial = await f.service.prepare('Ari freezes')
    await f.service.start(initial.case.id, 'fix', agent, false)
    await writeFile(join(f.store.directory(initial.case.id), 'fix', 'file.txt'), 'fixed\n')
    const checked = await f.service.verify(initial.case.id)
    vi.spyOn(f.github, 'findPr').mockResolvedValue(null)
    const create = vi
      .spyOn(f.github, 'createPr')
      .mockImplementationOnce(async (input) => {
        await input.onCommit('d'.repeat(40))
        throw new Error('Lost acknowledgement')
      })
      .mockResolvedValue({ number: 8, url: 'https://github.com/j35dev/Ari/pull/8' })
    await expect(
      f.service.publishPr(initial.case.id, draft, checked.verification!.revision, 'contributor'),
    ).rejects.toThrow('Lost acknowledgement')
    const revised = { ...draft, body: 'Updated description of the same verified fix' }
    expect(
      (
        await f.service.publishPr(
          initial.case.id,
          revised,
          checked.verification!.revision,
          'contributor',
        )
      ).pr?.number,
    ).toBe(8)
    expect(create.mock.calls[1]?.[0].commit).toBe('d'.repeat(40))
  })
  it('can reconcile an issue without starting a second public write', async () => {
    const f = await fixture(),
      initial = await f.service.prepare('Ari freezes')
    const create = vi
      .spyOn(f.github, 'createIssue')
      .mockRejectedValue(new Error('Lost acknowledgement'))
    await expect(f.service.publishIssue(initial.case.id, draft, 'contributor')).rejects.toThrow()
    vi.spyOn(f.github, 'findIssue').mockResolvedValue({
      number: 9,
      url: 'https://github.com/j35dev/Ari/issues/9',
    })
    expect((await f.service.recover(initial.case.id)).issue?.number).toBe(9)
    expect(create).toHaveBeenCalledOnce()
  })
  it('never duplicates an issue after a lost acknowledgement, including after restart', async () => {
    const f = await fixture(),
      item = await f.service.prepare('Ari freezes')
    const create = vi
      .spyOn(f.github, 'createIssue')
      .mockRejectedValue(new Error('Connection lost after request'))
    await expect(f.service.publishIssue(item.case.id, draft, 'contributor')).rejects.toThrow(
      'Connection lost',
    )
    expect((await f.store.get(item.case.id)).case.issueReceipt?.pending).toBe(true)
    const found = { number: 123, url: 'https://github.com/j35dev/Ari/issues/123' }
    vi.spyOn(f.github, 'findIssue').mockResolvedValue(found)
    const restarted = new TriageService({
      ...f.service.deps,
      store: new TriageCaseStore(f.store.root),
    })
    expect((await restarted.publishIssue(item.case.id, draft, 'contributor')).issue).toEqual(found)
    expect(create).toHaveBeenCalledOnce()
  })
  it('permits retry of a definitively rejected request and refuses account changes', async () => {
    const f = await fixture(),
      item = await f.service.prepare('Ari freezes')
    const create = vi
      .spyOn(f.github, 'createIssue')
      .mockRejectedValue(new HostingError('failed', 'Forbidden', 403))
    await expect(f.service.publishIssue(item.case.id, draft, 'someone-else')).rejects.toThrow(
      'account changed',
    )
    expect(create).not.toHaveBeenCalled()
    await expect(f.service.publishIssue(item.case.id, draft, 'contributor')).rejects.toThrow(
      'Forbidden',
    )
    expect((await f.store.get(item.case.id)).case.issueReceipt?.pending).toBe(false)
    create.mockResolvedValue({ number: 1, url: 'https://github.com/j35dev/Ari/issues/1' })
    expect((await f.service.publishIssue(item.case.id, draft, 'contributor')).issue?.number).toBe(1)
  })
  it('rejects credential-bearing drafts before invoking GitHub', async () => {
    const f = await fixture(),
      item = await f.service.prepare('Bug')
    const create = vi.spyOn(f.github, 'createIssue')
    await expect(
      f.service.publishIssue(item.case.id, { ...draft, body: 'api_key=private' }, 'contributor'),
    ).rejects.toThrow('credential-like')
    expect(create).not.toHaveBeenCalled()
  })
  it('exports disk diagnostics without a running app or any session credentials', async () => {
    const cli = createRequire(import.meta.url)('../../../resources/cli/triage.cjs') as {
      run: (args: string[], env: NodeJS.ProcessEnv) => Promise<void>
    }
    await mkdir(join(root, 'triage'))
    await writeFile(
      join(root, 'triage', 'build.json'),
      JSON.stringify({ appVersion: '0.3.10', buildCommit: 'a'.repeat(40) }),
    )
    await writeFile(
      join(root, 'triage', 'logs.jsonl'),
      JSON.stringify({ at: Date.now(), message: 'password=private crashed' }) + '\n',
    )
    vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    await cli.run(['--export', '--profile', root], {})
    const directory = (await readdir(join(root, 'triage', 'terminal')))[0]!
    const context = JSON.parse(
      await readFile(join(root, 'triage', 'terminal', directory, 'context.json'), 'utf8'),
    ) as TriageContext
    expect(context.appVersion).toBe('0.3.10')
    expect(context.logs).not.toContain('private')
    expect(context.logs).toContain('crashed')
  })
})
