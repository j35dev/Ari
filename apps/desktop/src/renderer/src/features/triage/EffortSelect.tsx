import { useEffect, useState } from 'react'
import type { ProjectAgent } from '@ari/contracts/project'
import { rpc } from '../../lib/rpc'

export function EffortSelect({
  agent,
  onChange,
  disabled,
}: {
  agent: ProjectAgent
  onChange: (effort: string | null) => void
  disabled: boolean
}) {
  const [efforts, setEfforts] = useState<{ id: string; label: string }[]>([])
  useEffect(() => {
    let alive = true
    setEfforts([])
    rpc
      .invoke('providers.efforts', { kind: agent.driverKind, modelId: agent.modelId })
      .then((result) => {
        if (alive) setEfforts(result.efforts)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [agent.driverKind, agent.modelId])
  if (!efforts.length) return null
  return (
    <select
      aria-label="Triage reasoning effort"
      disabled={disabled}
      value={agent.effort ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
    >
      <option value="">Agent’s default effort</option>
      {efforts.map((effort) => (
        <option value={effort.id} key={effort.id}>
          {effort.label}
        </option>
      ))}
    </select>
  )
}
