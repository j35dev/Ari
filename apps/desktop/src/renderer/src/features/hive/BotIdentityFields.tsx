import { Field } from '@ari/ui/field'
import { Input } from '@ari/ui/input'
import { Textarea } from '@ari/ui/textarea'
import { BOT_TAGLINE_MAX, BOT_TITLE_MAX, type BotDraft } from './bot-draft'

export interface BotIdentityFieldsProps {
  draft: BotDraft
  onChange: (change: Partial<BotDraft>) => void
  autoFocusName?: boolean
}

const PERSONA_PLACEHOLDER = 'You are Pixel, a careful UI engineer. You read before you write.'

/** Who a bot is, in words: name, title, tagline and persona. Shared by the new and edit dialogs. */
export function BotIdentityFields({
  draft,
  onChange,
  autoFocusName = false,
}: BotIdentityFieldsProps) {
  return (
    <>
      <div className="flex gap-3">
        <div className="min-w-0 flex-1">
          <Field label="Name">
            {(control) => (
              <Input
                {...control}
                autoFocus={autoFocusName}
                value={draft.name}
                placeholder="Pixel"
                onChange={(event) => onChange({ name: event.target.value })}
              />
            )}
          </Field>
        </div>
        <div className="min-w-0 flex-1">
          <Field label="Title">
            {(control) => (
              <Input
                {...control}
                value={draft.title}
                maxLength={BOT_TITLE_MAX}
                placeholder="Designer"
                onChange={(event) => onChange({ title: event.target.value })}
              />
            )}
          </Field>
        </div>
      </div>

      <Field label="Tagline" hint="One line in the bot's own voice.">
        {(control) => (
          <Input
            {...control}
            value={draft.tagline}
            maxLength={BOT_TAGLINE_MAX}
            placeholder="Spacing, states, contrast: I sweat the details users feel."
            onChange={(event) => onChange({ tagline: event.target.value })}
          />
        )}
      </Field>

      <Field label="Persona" hint="Markdown. What this bot is here to do.">
        {(control) => (
          <Textarea
            {...control}
            autoGrow
            value={draft.personaMd}
            placeholder={PERSONA_PLACEHOLDER}
            onChange={(event) => onChange({ personaMd: event.target.value })}
          />
        )}
      </Field>
    </>
  )
}
