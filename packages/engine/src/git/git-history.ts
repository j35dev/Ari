import type { SourceControlError, GitHistoryEntry, SourceControlStatus } from '@ari/contracts/rpc'
import { ok, type Result } from '@ari/shared/result'
import type { RepositoryGit } from './repository-git'

/** Reads bounded commit and stash lists without changing refs or fetching a remote. */
export async function readGitHistory(
  git: RepositoryGit,
  status: SourceControlStatus,
  signal?: AbortSignal,
): Promise<Result<{ commits: GitHistoryEntry[]; stashes: GitHistoryEntry[] }, SourceControlError>> {
  const parse = (text: string): GitHistoryEntry[] => {
    const fields = text.split('\0')
    const result: GitHistoryEntry[] = []
    for (let at = 0; at + 3 < fields.length; at += 4) {
      const oid = fields[at]!.trim()
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) continue
      result.push({ oid, subject: fields[at + 1]!, author: fields[at + 2]!, at: fields[at + 3]! })
    }
    return result
  }
  const format = '--format=%H%x00%s%x00%an%x00%aI%x00'
  const commits = status.headOid
    ? await git.run(['log', '-60', format, '--'], { signal, maxBytes: 512 * 1024 })
    : ok('')
  if (!commits.ok) return commits
  const stashes = await git.run(['stash', 'list', '-30', format], { signal, maxBytes: 256 * 1024 })
  if (!stashes.ok) return stashes
  return ok({ commits: parse(commits.value), stashes: parse(stashes.value) })
}
