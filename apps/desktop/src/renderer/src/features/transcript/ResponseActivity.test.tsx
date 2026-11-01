import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ResponseActivity, type StyledResponse } from './ResponseActivity'
import type { ToolGroupRow, TranscriptBlock } from './types'

const styles: StyledResponse[] = ['flow', 'fold', 'margin', 'signal']
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function call(id: string, name = 'Bash', argsJson = '{"command":"pnpm test"}'): TranscriptBlock {
  return { key: `call-${id}`, kind: 'tool-call', callId: id, name, argsJson }
}
function result(id: string, output = 'real command output', isError = false): TranscriptBlock {
  return {
    key: `result-${id}`,
    kind: 'tool-result',
    callId: id,
    resultJson: JSON.stringify(output),
    isError,
  }
}
function group(blocks: TranscriptBlock[]): ToolGroupRow {
  return {
    kind: 'tool-group',
    key: 'group',
    blocks,
    calls: blocks.filter((block) => block.kind === 'tool-call'),
    resultsByCallId: new Map(
      blocks
        .filter((block) => block.kind === 'tool-result' && block.callId)
        .map((block) => [block.callId!, block]),
    ),
  }
}
function inspectForeground(container: HTMLElement) {
  return within(container.querySelector<HTMLElement>('.ari-response-tool-card')!).getByRole(
    'button',
    { name: /^Inspect / },
  )
}
const read = call('read', 'Read', '{"path":"src/config.ts"}')
const run = call('run')
const thought: TranscriptBlock = {
  key: 'thinking',
  kind: 'thinking',
  text: 'Checking the existing behavior\nA provider-supplied reasoning detail.',
}

describe.each(styles)('%s tool presentation', (style) => {
  it('renders real source metadata and opens the original input/output components', async () => {
    const onExplore = vi.fn()
    const { container } = render(
      <ResponseActivity
        row={group([read, result('read'), run, result('run')])}
        active
        turnRunning
        style={style}
        onExplore={onExplore}
      />,
    )
    expect(container.querySelector('.ari-response-activity')).toHaveAttribute(
      'data-response-style',
      style,
    )
    expect(container.querySelector('.ari-response-tool-card')).toHaveAttribute(
      'data-tool-state',
      'returned',
    )
    expect(screen.getByText('real command output')).toBeInTheDocument()
    await userEvent.setup().click(inspectForeground(container))
    const details = screen.getByRole('region', { name: 'Tool details: Run pnpm test' })
    expect(within(details).getByText('Ari Run')).toBeInTheDocument()
    expect(details).toHaveTextContent('pnpm test')
    expect(details).toHaveTextContent('real command output')
    expect(onExplore).toHaveBeenCalled()
  })

  it('keeps calls and reasoning in source order in the full activity history', async () => {
    const { container } = render(
      <ResponseActivity
        row={group([read, result('read'), thought, run])}
        active
        turnRunning
        style={style}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Show all activity' }))
    const history = screen.getByRole('list', { name: 'Tool activity history' })
    const buttons = within(history).getAllByRole('button')
    expect(buttons[0]).toHaveAccessibleName('Inspect tool 1: Read src/config.ts, Returned')
    expect(buttons[1]).toHaveAccessibleName('Reasoning')
    expect(buttons[2]).toHaveAccessibleName('Inspect tool 2: Run pnpm test, Running')
    await user.click(buttons[1]!)
    expect(history).toHaveTextContent('A provider-supplied reasoning detail.')
    expect(container.querySelector('.ari-response-history')).toBeInTheDocument()
  })

  it('keeps a failure visible in the collapsed summary without claiming the turn succeeded', async () => {
    const { container } = render(
      <ResponseActivity
        row={group([run, result('run', 'permission denied by tool', true)])}
        active={false}
        turnRunning={false}
        style={style}
      />,
    )
    expect(screen.getByText('1 failed')).toBeInTheDocument()
    const toggle = screen.getByRole('button', { name: /Expand activity:.*1 failed/ })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.setup().click(toggle)
    expect(container.querySelector('.ari-response-tool-card')).toHaveAttribute(
      'data-tool-state',
      'failed',
    )
    expect(screen.getByText('permission denied by tool')).toBeInTheDocument()
  })

  it('never turns an unanswered call into a success on a stopped/settled turn', async () => {
    const { container } = render(
      <ResponseActivity row={group([run])} active={false} turnRunning={false} style={style} />,
    )
    await userEvent.setup().click(screen.getByRole('button', { name: /Expand activity/ }))
    expect(container.querySelector('.ari-response-tool-card')).toHaveAttribute(
      'data-tool-state',
      'unanswered',
    )
    expect(screen.getByText('No result was received for this call.')).toBeInTheDocument()
    expect(screen.queryByText('Returned')).not.toBeInTheDocument()
  })

  it('follows an earlier concurrent call until it returns, not just the latest call', () => {
    const { container } = render(
      <ResponseActivity row={group([read, run, result('run')])} active turnRunning style={style} />,
    )
    expect(container.querySelector('.ari-response-tool-card h4')).toHaveTextContent('src/config.ts')
    expect(container.querySelector('.ari-response-tool-card')).toHaveAttribute(
      'data-tool-state',
      'running',
    )
  })

  it('holds inspected evidence open as calls append and the turn settles', async () => {
    const pending = group([run])
    const { container, rerender } = render(
      <ResponseActivity row={pending} active turnRunning style={style} />,
    )
    await userEvent.setup().click(inspectForeground(container))
    const before = screen.getByRole('region', { name: 'Tool details: Run pnpm test' })
    const next = group([
      run,
      result('run', 'confirmed output'),
      call('new', 'Read', '{"path":"new.ts"}'),
    ])
    rerender(<ResponseActivity row={next} active turnRunning style={style} />)
    expect(screen.getByRole('region', { name: 'Tool details: Run pnpm test' })).toBe(before)
    expect(before).toHaveTextContent('confirmed output')
    vi.useFakeTimers()
    rerender(<ResponseActivity row={next} active={false} turnRunning={false} style={style} />)
    await act(() => vi.advanceTimersByTime(350))
    expect(before).toBeInTheDocument()
    expect(container.querySelector('.ari-response-summary')).toHaveAttribute(
      'aria-expanded',
      'true',
    )
  })

  it('retains image-generation progress and exposes the original image prompt', () => {
    render(
      <ResponseActivity
        row={group([
          call('image', 'image_gen__imagegen', '{"prompt":"An observatory in the mountains"}'),
        ])}
        active
        turnRunning
        style={style}
      />,
    )
    expect(screen.getByRole('region', { name: 'Generating image' })).toBeInTheDocument()
    expect(screen.getByText('An observatory in the mountains')).toBeInTheDocument()
  })

  it('keeps an imported orphan result available in the history', async () => {
    render(
      <ResponseActivity
        row={group([result('missing-call', 'An imported result')])}
        active={false}
        turnRunning={false}
        style={style}
      />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Expand activity: Tool results/ }))
    await user.click(screen.getByRole('button', { name: 'Show all activity' }))
    expect(screen.getByRole('list', { name: 'Tool activity history' })).toHaveTextContent(
      'An imported result',
    )
  })
})

describe('optional response interactions', () => {
  it('preserves the same inspected input/output across the four optional styles', async () => {
    const row = group([run, result('run')])
    const { container, rerender } = render(
      <ResponseActivity row={row} active turnRunning style="flow" />,
    )
    await userEvent.setup().click(inspectForeground(container))
    const details = screen.getByRole('region', { name: 'Tool details: Run pnpm test' })
    for (const style of styles) {
      rerender(<ResponseActivity row={row} active turnRunning style={style} />)
      expect(screen.getByRole('region', { name: 'Tool details: Run pnpm test' })).toBe(details)
    }
  })

  it('restores keyboard focus to the summary if a live tool replaced the original opener', async () => {
    const { container, rerender } = render(
      <ResponseActivity row={group([run])} active turnRunning style="flow" />,
    )
    const user = userEvent.setup()
    await user.click(inspectForeground(container))
    rerender(
      <ResponseActivity row={group([run, result('run'), read])} active turnRunning style="flow" />,
    )
    await user.click(screen.getByRole('button', { name: 'Close tool details' }))
    expect(container.querySelector('.ari-response-summary')).toHaveFocus()
  })

  it('keeps Signal selection pinned while the next tool arrives, until Follow current is chosen', async () => {
    const { container, rerender } = render(
      <ResponseActivity
        row={group([read, result('read'), run])}
        active
        turnRunning
        style="signal"
      />,
    )
    const user = userEvent.setup()
    await user.click(
      screen.getByRole('button', { name: 'Select tool 1: Read src/config.ts, Returned' }),
    )
    rerender(
      <ResponseActivity
        row={group([
          read,
          result('read'),
          run,
          result('run'),
          call('later', 'Read', '{"path":"latest.ts"}'),
        ])}
        active
        turnRunning
        style="signal"
      />,
    )
    expect(container.querySelector('.ari-response-tool-card h4')).toHaveTextContent('src/config.ts')
    await user.click(screen.getByRole('button', { name: 'Follow current tool' }))
    expect(container.querySelector('.ari-response-tool-card h4')).toHaveTextContent('latest.ts')
  })

  it('bounds the Signal navigator but makes every call accessible in the history', async () => {
    const calls = Array.from({ length: 200 }, (_, index) => call(String(index)))
    render(<ResponseActivity row={group(calls)} active turnRunning style="signal" />)
    const events = screen.getByRole('navigation', { name: 'Tool events' })
    expect(within(events).getAllByRole('button', { name: /^Select tool/ })).toHaveLength(12)
    await userEvent.setup().click(within(events).getByRole('button', { name: /188 earlier/ }))
    expect(
      within(screen.getByRole('list', { name: 'Tool activity history' })).getAllByRole('button', {
        name: /^Inspect tool/,
      }),
    ).toHaveLength(200)
  })

  it('renders MCP images through the shared result body rather than displaying base64', async () => {
    const payload = {
      content: [
        { type: 'text', text: 'Image created' },
        { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
      ],
    }
    const { container } = render(
      <ResponseActivity
        row={group([run, { ...result('run'), resultJson: JSON.stringify(payload) }])}
        active
        turnRunning
        style="fold"
      />,
    )
    expect(container).not.toHaveTextContent('aGVsbG8=')
    await userEvent.setup().click(inspectForeground(container))
    expect(screen.getByRole('img', { name: 'Image' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open image' })).toBeInTheDocument()
  })

  it('closes the history and inspector when the activity is explicitly collapsed', async () => {
    const { container } = render(
      <ResponseActivity row={group([run])} active turnRunning style="flow" />,
    )
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Show all activity' }))
    await user.click(inspectForeground(container))
    await user.click(screen.getByRole('button', { name: /^Collapse activity/ }))
    expect(screen.queryByRole('list', { name: 'Tool activity history' })).not.toBeInTheDocument()
    expect(screen.queryByRole('region', { name: /^Tool details:/ })).not.toBeInTheDocument()
  })
})
