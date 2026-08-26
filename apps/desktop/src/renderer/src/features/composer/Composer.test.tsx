import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer } from './Composer'
import { FILE_MIME } from './drag-file'

describe('Composer', () => {
  it('sends trimmed text on click and clears the field', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    await user.type(screen.getByLabelText('Message'), '  fix the bug  ')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).toHaveBeenCalledWith('fix the bug')
    expect(screen.getByLabelText('Message')).toHaveValue('')
  })

  it('sends on Enter and inserts newline on Shift+Enter', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, 'line one{Shift>}{Enter}{/Shift}line two')
    expect(onSend).not.toHaveBeenCalled()
    await user.type(input, '{Enter}')
    expect(onSend).toHaveBeenCalledOnce()
  })

  it('does not send empty or whitespace-only messages', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    await user.type(screen.getByLabelText('Message'), '   ')
    await user.click(screen.getByRole('button', { name: 'Send' }))
    expect(onSend).not.toHaveBeenCalled()
  })

  it('shows a stop button while running and calls onStop', async () => {
    const user = userEvent.setup()
    const onStop = vi.fn()
    render(<Composer onSend={vi.fn()} onStop={onStop} running />)
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onStop).toHaveBeenCalledOnce()
  })

  it('announces queued messages behind the active turn', () => {
    render(<Composer onSend={vi.fn()} running queued={['a', 'b']} />)
    expect(screen.getByText(/2 queued messages/)).toBeInTheDocument()
  })

  it('keeps stash and send as the trailing actions in the foot', () => {
    render(<Composer onSend={vi.fn()} leading={<span>agent</span>} />)
    const stash = screen.getByRole('button', { name: /prompt stash/i })
    const send = screen.getByRole('button', { name: 'Send' })
    expect(stash.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('Composer prompt stash', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('Mod+S stashes the draft, clears the field, and the menu restores it', async () => {
    const user = userEvent.setup()
    render(<Composer onSend={vi.fn()} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, 'remember this prompt')
    expect(input).toHaveValue('remember this prompt')

    fireEvent.keyDown(input, { key: 's', ctrlKey: true })
    await waitFor(() => expect(input).toHaveValue(''))

    await user.click(screen.getByRole('button', { name: /prompt stash/i }))
    await user.click(screen.getByRole('menuitem', { name: /remember this prompt/ }))

    await waitFor(() => expect(screen.getByLabelText('Message')).toHaveValue(
      'remember this prompt',
    ))
  })

  it('stash entries persist for a fresh composer mount', async () => {
    const user = userEvent.setup()
    const first = render(<Composer onSend={vi.fn()} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, 'persistent idea')
    fireEvent.keyDown(input, { key: 's', ctrlKey: true })
    first.unmount()

    render(<Composer onSend={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /prompt stash/i }))
    expect(screen.getByText('persistent idea')).toBeInTheDocument()
  })

  it('entries can be removed from the stash menu', async () => {
    localStorage.setItem(
      'ari.prompt-stash',
      JSON.stringify([{ text: 'doomed draft', savedAt: Date.now() }]),
    )
    const user = userEvent.setup()
    render(<Composer onSend={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /prompt stash/i }))
    await user.click(screen.getByRole('button', { name: 'Remove from stash' }))

    expect(screen.queryByText('doomed draft')).not.toBeInTheDocument()
    expect(localStorage.getItem('ari.prompt-stash')).toBe('[]')
  })
})

describe('Composer draft seeding', () => {
  it('replaces the draft, focuses the field, and sends the edited text', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const { rerender } = render(<Composer onSend={onSend} />)
    await user.type(screen.getByLabelText('Message'), 'draft in progress')
    rerender(<Composer onSend={onSend} seed={{ text: 'first attempt, corrected:', nonce: 1 }} />)

    const input = screen.getByLabelText('Message')
    await waitFor(() => expect(input).toHaveValue('first attempt, corrected:'))
    await waitFor(() => expect(input).toHaveFocus())
    await user.type(input, ' with the fix{Enter}')
    expect(onSend).toHaveBeenCalledWith('first attempt, corrected: with the fix')
  })

  it('applies a new nonce over both user edits and earlier seeds', async () => {
    const { rerender } = render(
      <Composer onSend={vi.fn()} seed={{ text: 'one', nonce: 1 }} />,
    )
    const input = screen.getByLabelText('Message')
    await waitFor(() => expect(input).toHaveValue('one'))
    rerender(<Composer onSend={vi.fn()} seed={{ text: 'two', nonce: 2 }} />)
    await waitFor(() => expect(input).toHaveValue('two'))
  })

  it('ignores a repeated nonce so typing is never clobbered', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<Composer onSend={vi.fn()} seed={{ text: 'seed', nonce: 7 }} />)
    const input = screen.getByLabelText('Message')
    await waitFor(() => expect(input).toHaveValue('seed'))
    await user.clear(input)
    await user.type(input, 'my own words')
    rerender(<Composer onSend={vi.fn()} seed={{ text: 'seed', nonce: 7 }} />)
    expect(input).toHaveValue('my own words')
  })
})

describe('Composer image attachments', () => {
  function imageFile(name: string): File {
    return new File([new Uint8Array(8)], name, { type: 'image/png' })
  }

  /** Minimal FileList stand-in, as paste/drop handlers receive. */
  function fakeFileList(files: File[]): FileList {
    return Object.assign([...files], {
      item: (index: number) => files[index] ?? null,
    })
  }

  function pasteImages(input: HTMLElement, files: File[]): void {
    fireEvent.paste(input, { clipboardData: { files: fakeFileList(files) } })
  }

  it('renders the attachment strip after pasting images', () => {
    render(<Composer onSend={vi.fn()} />)
    pasteImages(screen.getByLabelText('Message'), [imageFile('shot.png')])

    const strip = screen.getByRole('list', { name: 'Attached images' })
    expect(strip).toBeInTheDocument()
    expect(screen.getByRole('img', { name: 'shot.png' })).toBeInTheDocument()
  })

  it('ignores non-image paste payloads', () => {
    render(<Composer onSend={vi.fn()} />)
    pasteImages(screen.getByLabelText('Message'), [
      new File(['hello'], 'notes.txt', { type: 'text/plain' }),
    ])

    expect(screen.queryByRole('list', { name: 'Attached images' })).not.toBeInTheDocument()
  })

  it('removes a chip via its remove button', () => {
    render(<Composer onSend={vi.fn()} />)
    pasteImages(screen.getByLabelText('Message'), [imageFile('a.png'), imageFile('b.png')])
    expect(screen.getAllByRole('listitem')).toHaveLength(2)

    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }))

    expect(screen.getByRole('img', { name: 'b.png' })).toBeInTheDocument()
    expect(screen.queryByRole('img', { name: 'a.png' })).not.toBeInTheDocument()
  })

  it('clears pending images when the message is sent', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer onSend={onSend} />)
    const input = screen.getByLabelText('Message')
    pasteImages(input, [imageFile('shot.png')])
    await user.type(input, 'look at this{Enter}')

    expect(onSend).toHaveBeenCalledWith('look at this')
    expect(screen.queryByRole('list', { name: 'Attached images' })).not.toBeInTheDocument()
  })
})

describe('Composer slash popup', () => {
  it('shows filtered commands while a slash token is typed and commits on Enter', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    const onSlashCommand = vi.fn()
    render(<Composer onSend={onSend} onSlashCommand={onSlashCommand} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, '/mo')
    const options = screen.getAllByRole('option')
    expect(options.map((option) => option.textContent)).toMatchObject([
      expect.stringContaining('/model'),
      expect.stringContaining('/mode'),
    ])
    await user.type(input, '{Enter}')
    expect(onSlashCommand).toHaveBeenCalledWith('model')
    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('')
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument()
  })

  it('clears only the slash token mid-text', async () => {
    const user = userEvent.setup()
    const onSlashCommand = vi.fn()
    render(<Composer onSend={vi.fn()} onSlashCommand={onSlashCommand} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, 'run /cle')
    expect(screen.getAllByRole('option')).toHaveLength(1)
    await user.type(input, '{Enter}')
    expect(onSlashCommand).toHaveBeenCalledWith('clear')
    expect(input).toHaveValue('run ')
  })

  it('commits on click', async () => {
    const user = userEvent.setup()
    const onSlashCommand = vi.fn()
    render(<Composer onSend={vi.fn()} onSlashCommand={onSlashCommand} />)
    await user.type(screen.getByLabelText('Message'), '/')
    await user.click(screen.getAllByRole('option')[2]!)
    expect(onSlashCommand).toHaveBeenCalledWith('clear')
  })

  it('closes on Escape and reopens when the token changes', async () => {
    const user = userEvent.setup()
    render(<Composer onSend={vi.fn()} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, '/mo')
    expect(screen.getByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument()
    await user.type(input, '{Escape}')
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument()
    await user.type(input, 'd')
    expect(screen.getByRole('listbox', { name: 'Slash commands' })).toBeInTheDocument()
  })

  it('shows nothing for plain text or a glued slash', async () => {
    const user = userEvent.setup()
    render(<Composer onSend={vi.fn()} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, 'hello')
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument()
    await user.type(input, ' abc/')
    expect(screen.queryByRole('listbox', { name: 'Slash commands' })).not.toBeInTheDocument()
  })
})

describe('Composer mention popup', () => {
  const SUGGESTIONS = ['src/app.ts', 'src/main.tsx', 'docs/arch.md']

  it('renders nothing without suggestions even on an @ token', async () => {
    const user = userEvent.setup()
    render(<Composer onSend={vi.fn()} />)
    await user.type(screen.getByLabelText('Message'), '@')
    expect(screen.queryByRole('listbox', { name: 'File mentions' })).not.toBeInTheDocument()
  })

  it('lists matching paths and inserts the chosen one on Enter', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer onSend={onSend} suggestions={SUGGESTIONS} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, 'fix @ap')
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0]!.textContent).toContain('src/app.ts')
    await user.type(input, '{Enter}')
    expect(onSend).not.toHaveBeenCalled()
    expect(input).toHaveValue('fix @src/app.ts ')
    expect(screen.queryByRole('listbox', { name: 'File mentions' })).not.toBeInTheDocument()
  })

  it('includes the inserted mention when the message is sent', async () => {
    const user = userEvent.setup()
    const onSend = vi.fn()
    render(<Composer onSend={onSend} suggestions={SUGGESTIONS} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, '@main')
    await user.type(input, '{Enter}')
    await user.type(input, 'x{Enter}')
    expect(onSend).toHaveBeenCalledWith('@src/main.tsx x')
  })

  it('lists at most 8 paths', async () => {
    const user = userEvent.setup()
    const many = Array.from({ length: 10 }, (_, i) => `file-${i}.ts`)
    render(<Composer onSend={vi.fn()} suggestions={many} />)
    await user.type(screen.getByLabelText('Message'), '@')
    expect(screen.getAllByRole('option')).toHaveLength(8)
  })
})

describe('Composer file drag-drop', () => {
  /** DataTransfer stand-in for an in-app pane-row drag (see drag-file.ts). */
  function fileDrag(path: string) {
    return {
      types: [FILE_MIME],
      files: [],
      getData: (type: string) => (type === FILE_MIME ? path : ''),
    }
  }

  it('inserts a dragged pane file as a mention at the caret', async () => {
    const user = userEvent.setup()
    render(<Composer onSend={vi.fn()} />)
    const input = screen.getByLabelText('Message')
    await user.type(input, 'see ')

    fireEvent.dragOver(input, { dataTransfer: fileDrag('src/app.ts') })
    fireEvent.drop(input, { dataTransfer: fileDrag('src/app.ts') })

    expect(input).toHaveValue('see @src/app.ts ')
  })

  it('keeps OS file drops on the image attachment path', () => {
    render(<Composer onSend={vi.fn()} />)
    const input = screen.getByLabelText('Message')
    const file = new File([new Uint8Array(8)], 'shot.png', { type: 'image/png' })

    fireEvent.drop(input, {
      dataTransfer: { types: ['Files'], files: [file], getData: () => '' },
    })

    expect(screen.getByRole('list', { name: 'Attached images' })).toBeInTheDocument()
    expect(input).toHaveValue('')
  })
})
