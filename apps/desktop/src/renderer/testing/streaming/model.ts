/** Proposed presentation contract, deliberately isolated from production AgentEvent. */
export type Status = 'running' | 'completed' | 'failed' | 'cancelled' | 'unconfirmed'
export type Category = 'command' | 'read' | 'search' | 'edit' | 'other'
export type Payload =
  | { type: 'narration'; itemId: string; text: string; mode: 'append' | 'replace' }
  | {
      type: 'tool'
      callId: string
      name?: string
      args?: string
      category?: Category
      status?: Status
      output?: string
      outputMode?: 'append' | 'replace'
      version?: number
    }
  | {
      type: 'decision'
      id: string
      kind: 'approval' | 'question'
      text: string
      command?: string
      options: string[]
    }
  | { type: 'resolved'; id: string; answer: string }
  | { type: 'diagnostic'; text: string }
  | { type: 'connection'; connected: boolean }
  | { type: 'settled'; reason: 'completed' | 'cancelled' }
export type ReplayEvent = Payload & { seq: number; turnId: string }
export type Tool = {
  key: string
  callId: string
  name: string
  args: string
  category: Category
  status: Status
  output: string
  version: number
  firstSeq: number
  turnId: string
  observedStart: boolean
}
export type Row =
  | { kind: 'narration'; key: string; text: string; turnId: string }
  | { kind: 'activity'; key: string; toolKeys: string[]; turnId: string }
  | {
      kind: 'decision'
      key: string
      id: string
      decisionKind: 'approval' | 'question'
      text: string
      command?: string
      options: string[]
      answer?: string
      turnId: string
    }
  | { kind: 'diagnostic'; key: string; text: string; turnId: string }
export type Presentation = {
  rows: Row[]
  tools: Map<string, Tool>
  connected: boolean
  settled: boolean
  uniqueEvents: number
}

/** Journal sequence is authoritative. Repeated delivery is idempotent; gaps can arrive later. */
export function project(events: readonly ReplayEvent[]): Presentation {
  const journal = new Map(events.map((event) => [event.seq, event]))
  const rows: Row[] = []
  const tools = new Map<string, Tool>()
  const narration = new Map<string, Extract<Row, { kind: 'narration' }>>()
  const decisions = new Map<string, Extract<Row, { kind: 'decision' }>>()
  let group: Extract<Row, { kind: 'activity' }> | null = null
  let connected = true
  let settled = false
  let lastTurn = ''
  for (const event of [...journal.values()].sort((a, b) => a.seq - b.seq)) {
    const beginRow = () => {
      if (lastTurn !== event.turnId) {
        lastTurn = event.turnId
        settled = false
      }
    }
    const scoped = (id: string) => `${event.turnId}:${id}`
    switch (event.type) {
      case 'narration': {
        const key = scoped(event.itemId)
        const existing = narration.get(key)
        if (existing)
          existing.text = event.mode === 'append' ? existing.text + event.text : event.text
        else if (event.text.trim()) {
          beginRow()
          const row: Extract<Row, { kind: 'narration' }> = {
            kind: 'narration',
            key,
            text: event.text,
            turnId: event.turnId,
          }
          narration.set(key, row)
          rows.push(row)
          group = null
        }
        break
      }
      case 'tool': {
        const key = scoped(event.callId)
        const prev = tools.get(key)
        const tool: Tool = prev ?? {
          key,
          callId: event.callId,
          name: event.name ?? 'Tool',
          args: '',
          category: event.category ?? 'other',
          status: 'running',
          output: '',
          version: -1,
          firstSeq: event.seq,
          turnId: event.turnId,
          observedStart: event.name !== undefined,
        }
        // Versioned snapshots cannot overwrite newer state. Delta delivery is keyed by journal seq.
        if (event.version !== undefined && event.version < tool.version) break
        if (event.name !== undefined) tool.name = event.name
        if (event.args !== undefined) tool.args = event.args
        if (event.category !== undefined) tool.category = event.category
        if (event.status !== undefined) tool.status = event.status
        if (event.output !== undefined)
          tool.output = event.outputMode === 'append' ? tool.output + event.output : event.output
        tool.version = event.version ?? tool.version
        tools.set(key, tool)
        if (!prev) {
          beginRow()
          if (!group || group.turnId !== event.turnId) {
            group = {
              kind: 'activity',
              key: scoped(`activity:${event.seq}`),
              toolKeys: [],
              turnId: event.turnId,
            }
            rows.push(group)
          }
          group.toolKeys.push(key)
        }
        break
      }
      case 'decision': {
        const existing = decisions.get(scoped(event.id))
        if (existing) {
          existing.text = event.text
          existing.options = event.options
          existing.command = event.command
          break
        }
        beginRow()
        group = null
        const row: Extract<Row, { kind: 'decision' }> = {
          kind: 'decision',
          key: scoped(event.id),
          id: event.id,
          decisionKind: event.kind,
          text: event.text,
          command: event.command,
          options: event.options,
          turnId: event.turnId,
        }
        decisions.set(scoped(event.id), row)
        rows.push(row)
        break
      }
      case 'resolved': {
        const row = decisions.get(scoped(event.id))
        if (row) row.answer = event.answer
        break
      }
      case 'diagnostic':
        beginRow()
        group = null
        rows.push({
          kind: 'diagnostic',
          key: scoped(`diagnostic:${event.seq}`),
          text: event.text,
          turnId: event.turnId,
        })
        break
      case 'connection':
        connected = event.connected
        break
      case 'settled':
        if (lastTurn === event.turnId) settled = true
        if (group?.turnId === event.turnId) group = null
        for (const tool of tools.values())
          if (tool.turnId === event.turnId && tool.status === 'running')
            tool.status = event.reason === 'cancelled' ? 'cancelled' : 'unconfirmed'
        break
    }
  }
  return { rows, tools, connected, settled, uniqueEvents: journal.size }
}

export function tally(tools: readonly Tool[]): string {
  const labels: Record<Category, [string, string]> = {
    command: ['command', 'commands'],
    read: ['file read', 'file reads'],
    search: ['search', 'searches'],
    edit: ['edit call', 'edit calls'],
    other: ['other tool', 'other tools'],
  }
  return (['read', 'search', 'command', 'edit', 'other'] as const)
    .flatMap((category) => {
      const count = tools.filter((tool) => tool.category === category).length
      return count ? [`${count} ${labels[category][count === 1 ? 0 : 1]}`] : []
    })
    .join(' · ')
}

/** Readable view is derived. Raw bytes remain available under Raw output. No regex prose summaries. */
export function readableOutput(raw: string): string {
  // eslint-disable-next-line no-control-regex -- Intentionally handles OSC terminal control sequences in a derived view.
  const osc = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g
  // eslint-disable-next-line no-control-regex -- Intentionally handles ANSI terminal control sequences in a derived view.
  const csi = /\x1b\[[0-?]*[ -/]*[@-~]/g
  return raw
    .replace(osc, '')
    .replace(csi, '')
    .split('\n')
    .map((line) => line.split('\r').at(-1) ?? '')
    .join('\n')
}
