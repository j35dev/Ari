import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rename, writeFile, realpath } from 'node:fs/promises'
import { join, relative, isAbsolute, sep } from 'node:path'
import {
  triageCaseSchema,
  triageContextSchema,
  triageIdSchema,
  type TriageCase,
  type TriageContext,
  type TriageSnapshot,
} from '@ari/contracts/triage'
import { boundedJson } from './diagnostics'

export class TriageCaseStore {
  constructor(readonly root: string) {}
  directory(id: string): string {
    return join(this.root, 'workspaces', triageIdSchema.parse(id))
  }
  private file(id: string): string {
    return join(this.root, 'cases', `${triageIdSchema.parse(id)}.json`)
  }
  async create(description: string, context: TriageContext): Promise<TriageSnapshot> {
    const id = `triage_${randomUUID().replaceAll('-', '')}`
    const now = Date.now()
    const item: TriageCase = {
      version: 1,
      id,
      description,
      createdAt: now,
      updatedAt: now,
      phase: 'ready',
      projectId: null,
      fixProjectId: null,
      investigationSessionId: null,
      fixSessionId: null,
      source: null,
      sourceError: null,
      fixBase: null,
      fixBranch: null,
      includeLogs: null,
      agent: null,
      fixAgent: null,
      issueDraft: {
        title: description.split('\n')[0]!.slice(0, 200),
        body: `## What happened\n\n${description}\n\n## Steps to reproduce\n\n1. \n\n## Expected\n\n## Actual\n\n## Environment\n\n- OS: ${context.platform} ${context.osRelease} (${context.arch})\n- Ari version / commit: ${context.appVersion} / ${context.buildCommit ?? 'unknown'}\n- Agent CLI involved (if any):\n`,
      },
      prDraft: {
        title: `fix: ${description.split('\n')[0]!.slice(0, 190)}`,
        body: '## Problem and fix\n\n## Verification\n\n',
      },
      issue: null,
      pr: null,
      issueReceipt: null,
      prReceipt: null,
      verification: null,
    }
    await mkdir(this.directory(id), { recursive: true })
    await this.save(item, context)
    return { case: item, context }
  }
  async get(id: string): Promise<TriageSnapshot> {
    const raw = await boundedJson(this.file(id), 4_000_000)
    if (typeof raw !== 'object' || raw === null || !('case' in raw) || !('context' in raw))
      throw new Error('This triage case could not be loaded.')
    const snapshot = {
      case: triageCaseSchema.parse(raw.case),
      context: triageContextSchema.parse(raw.context),
    }
    if (snapshot.case.id !== id) throw new Error('Triage case identity does not match.')
    return snapshot
  }
  async save(item: TriageCase, context?: TriageContext): Promise<TriageCase> {
    const next = triageCaseSchema.parse({ ...item, updatedAt: Date.now() })
    const facts = context ?? (await this.get(item.id)).context
    const file = this.file(next.id)
    await mkdir(join(this.root, 'cases'), { recursive: true })
    const temp = `${file}.${randomUUID()}.tmp`
    await writeFile(
      temp,
      JSON.stringify({ case: next, context: triageContextSchema.parse(facts) }, null, 2),
      'utf8',
    )
    await rename(temp, file)
    return next
  }
  async list(): Promise<TriageCase[]> {
    const files = await readdir(join(this.root, 'cases')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    const items: TriageCase[] = []
    for (const file of files) {
      if (!/^triage_[a-f0-9]{32}\.json$/.test(file)) continue
      // A damaged case should not hide the other cases. It remains on disk for recovery.
      try {
        items.push((await this.get(file.slice(0, -5))).case)
      } catch {
        /* retained */
      }
    }
    return items.sort((a, b) => b.updatedAt - a.updatedAt)
  }
  async artifact(id: string, name: 'issue-draft.json' | 'pr-draft.json'): Promise<unknown> {
    const root = await realpath(
      name === 'pr-draft.json' ? join(this.directory(id), 'fix') : this.directory(id),
    )
    const target = await realpath(
      join(root, name === 'pr-draft.json' ? '.ari-triage-pr.json' : name),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT')
        throw new Error(
          'The agent has not prepared this draft yet. Continue the conversation and ask for a draft.',
        )
      throw error
    })
    const rel = relative(root, target)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error('The triage draft is outside its workspace.')
    return boundedJson(target)
  }
}
