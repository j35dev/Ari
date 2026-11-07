import { GitFork } from 'lucide-react'
import type { SourceControlProvider } from '@ari/contracts/rpc'
import { GithubMark } from '../github/GithubMark'

/** Quiet provider marks, sized like the rest of Ari's navigation icons. */
export function SourceControlMark({
  provider,
  size = 18,
}: {
  provider: SourceControlProvider | null
  size?: number
}) {
  if (provider === 'github') return <GithubMark size={size} />
  if (provider === 'gitlab')
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="m12 22-8.4-6.1L1 8.1l2.3-6.2c.2-.5.8-.5 1 0L7 9h10l2.7-7.1c.2-.5.8-.5 1 0L23 8.1l-2.6 7.8L12 22Zm0-2.1L16.3 11H7.7l4.3 8.9Z" />
      </svg>
    )
  if (provider === 'bitbucket')
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="M3 3h18l-3 18H6L3 3Zm6.1 6 1 6h3.8l1-6H9.1Z" />
      </svg>
    )
  if (provider === 'azure-devops')
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
        <path d="m3 8 5-5 13-2v19l-8 3-6-6h10V7L8 9v8l-5-3V8Z" />
      </svg>
    )
  if (provider === 'gitcafe')
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        aria-hidden
      >
        <path d="M4 8h12v9a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8Zm12 1h2a3 3 0 0 1 0 6h-2M7 2v3m4-3v3M3 22h15" />
      </svg>
    )
  return <GitFork size={size} aria-hidden />
}
