import { useId, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import type { BotCharacter } from '@ari/contracts/bot'
import { Shuffle } from 'lucide-react'
import { BotAvatar } from '@ari/ui/bot-avatar'
import { BOT_PALETTE_NAMES, BOT_SHAPES, randomCharacter } from '@ari/ui/bot-character'
import { Button } from '@ari/ui/button'

export interface BotLookEditorProps {
  value: BotCharacter
  onChange: (next: BotCharacter) => void
  /** Names the preview for assistive tech, e.g. the bot's name. */
  previewLabel?: string
  /** Off where the dialog already shows the bot large, as the edit dialog does. */
  preview?: boolean
  /** Source for Shuffle; tests pin it. */
  random?: () => number
}

const ITEM_FOCUS =
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-2'

function capitalise(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/**
 * A row of radios with the arrow-key behaviour of a native radio group: one
 * tab stop on the checked item, arrows move and select, Home and End jump.
 */
function RadioRow<T>({
  label,
  items,
  selected,
  onSelect,
  render,
  itemClass,
}: {
  label: string
  items: readonly T[]
  selected: number
  onSelect: (index: number) => void
  render: (item: T, index: number, checked: boolean) => { name: string; content: ReactNode }
  itemClass: (checked: boolean) => string
}) {
  const labelId = useId()
  const refs = useRef<(HTMLButtonElement | null)[]>([])

  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const last = items.length - 1
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? selected >= last
          ? 0
          : selected + 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? selected <= 0
            ? last
            : selected - 1
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? last
              : null
    if (next === null) return
    event.preventDefault()
    onSelect(next)
    refs.current[next]?.focus()
  }

  return (
    <div className="flex flex-col gap-1.5">
      <p id={labelId} className="text-sm font-medium text-fg">
        {label}
      </p>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        onKeyDown={move}
        className="flex flex-wrap items-center gap-1.5"
      >
        {items.map((item, index) => {
          const checked = index === selected
          const { name, content } = render(item, index, checked)
          return (
            <button
              key={name}
              ref={(node) => {
                refs.current[index] = node
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={name}
              title={name}
              tabIndex={checked || (selected < 0 && index === 0) ? 0 : -1}
              onClick={() => onSelect(index)}
              className={`${itemClass(checked)} ${ITEM_FOCUS}`}
            >
              {content}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Picks a bot's look: a live preview, a shape, a colour, or a roll of the
 * dice. The preview idles so the person sees the bot as the roster will.
 */
export function BotLookEditor({
  value,
  onChange,
  previewLabel,
  preview = true,
  random,
}: BotLookEditorProps) {
  const shuffle = (): void => {
    let next = randomCharacter(random)
    // A shuffle that lands on the same look reads as a dead button.
    for (let tries = 0; tries < 8; tries += 1) {
      if (next.shape !== value.shape || next.palette !== value.palette) break
      next = randomCharacter(random)
    }
    onChange(next)
  }

  return (
    <div className="flex items-start gap-4">
      {preview ? (
        <div className="flex size-28 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-1">
          <BotAvatar
            character={value}
            size={96}
            label={previewLabel === undefined ? 'Preview' : `${previewLabel} preview`}
          />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <RadioRow
          label="Shape"
          items={BOT_SHAPES}
          selected={BOT_SHAPES.indexOf(value.shape)}
          onSelect={(index) => onChange({ ...value, shape: BOT_SHAPES[index]! })}
          itemClass={(checked) =>
            `flex size-10 items-center justify-center rounded-lg border transition-colors ${
              checked
                ? 'border-accent bg-accent-subtle'
                : 'border-border bg-surface-1 hover:bg-surface-3'
            }`
          }
          render={(shape) => ({
            name: capitalise(shape),
            content: <BotAvatar character={{ shape, palette: value.palette }} size={32} />,
          })}
        />
        <RadioRow
          label="Colour"
          items={BOT_PALETTE_NAMES}
          selected={value.palette}
          onSelect={(palette) => onChange({ ...value, palette })}
          itemClass={(checked) =>
            `size-6 rounded-full border border-border/60 transition-shadow ${
              checked ? 'ring-2 ring-accent ring-offset-2 ring-offset-surface-2' : ''
            }`
          }
          render={(name, index) => ({
            name: capitalise(name),
            content: (
              <span
                aria-hidden="true"
                className="block size-full rounded-full"
                style={{ background: `var(--ari-bot-${index}-base)` }}
              />
            ),
          })}
        />
        <div>
          <Button type="button" size="sm" variant="ghost" onClick={shuffle}>
            <Shuffle size={13} strokeWidth={2} aria-hidden="true" />
            Shuffle
          </Button>
        </div>
      </div>
    </div>
  )
}
