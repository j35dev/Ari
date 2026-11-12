import type { ComponentProps } from 'react'
import type { GitScope } from '@ari/contracts/rpc'
import { SessionClientProvider, type SessionScope } from '../features/session/session-client'
import { useSourceControl } from '../features/changes/use-source-control'
import { GitControl } from '../features/changes/GitControl'
import { Titlebar } from './Titlebar'
import { useMachines } from '../features/machines/use-machines'
type Props = Omit<ComponentProps<typeof Titlebar>, 'git' | 'changeCount'> & {
  scope: SessionScope | null
  gitScope: GitScope | null
  onReview: () => void
  onRequests: () => void
}
/** The persistent Git chrome reads the same immutable owner as its normal tools. */
export function ScopedTitlebar(props: Props) {
  return <SessionClientProvider scope={props.scope ?? { kind: 'local', sessionId: '' }}>
    <ScopedTitlebarContent {...props} />
  </SessionClientProvider>
}
function ScopedTitlebarContent({ scope, gitScope, onReview, onRequests, ...props }: Props) {
  const changes = useSourceControl(gitScope, 'summary')
  const { machines } = useMachines()
  const machine = scope?.kind === 'remote' ? machines.find((item) => item.id === scope.machineId) : null
  const machineLabel = scope?.kind === 'remote' ? `${machine?.name ?? 'Remote machine'}${machine?.status === 'connected' ? '' : ` · ${machine?.status ?? 'unavailable'}`}` : undefined
  return <Titlebar {...props} machineLabel={machineLabel} changeCount={changes.summary?.changedFiles ?? null}
    git={gitScope && changes.summary ? <GitControl scope={gitScope} summary={changes.summary}
      refresh={changes.refresh} onReview={onReview} onPullRequests={onRequests} /> : undefined} />
}
