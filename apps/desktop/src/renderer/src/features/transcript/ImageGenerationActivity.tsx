import { useMemo, useState } from 'react'
import { ImageIcon, Sparkles } from 'lucide-react'
import { ElapsedSeconds } from '../moment/WorkingGlyph'
import { parseToolArgs, stringArg } from './toolLabels'
import type { TranscriptBlock } from './types'

const PROMPT_KEYS = ['prompt', 'description', 'text'] as const
const MAX_PROMPT_CHARS = 180

function promptPreview(call: TranscriptBlock): string | null {
  const parsed = parseToolArgs(call.argsJson)
  if (parsed === null) return null
  const prompt = stringArg(parsed.payload, PROMPT_KEYS) ?? stringArg(parsed.args, PROMPT_KEYS)
  if (prompt === null) return null
  const clean = prompt.replace(/\s+/g, ' ').trim()
  return clean.length > MAX_PROMPT_CHARS ? `${clean.slice(0, MAX_PROMPT_CHARS - 1)}…` : clean
}

/** Purpose-built live state for slow image tools; mounted when generation begins. */
export function ImageGenerationActivity({ call }: { call: TranscriptBlock }) {
  const [startedAt] = useState(() => Date.now())
  const prompt = useMemo(() => promptPreview(call), [call])

  return (
    <section
      aria-label="Generating image"
      aria-live="polite"
      className="ari-image-generation my-2 overflow-hidden rounded-xl border border-border bg-surface-1 shadow-1"
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <span className="flex size-7 items-center justify-center rounded-md bg-accent-subtle text-accent">
          <Sparkles size={14} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-mono text-2xs uppercase tracking-[0.16em] text-fg-subtle">
            Image studio
          </p>
          <p className="text-xs font-medium text-fg">Rendering your image</p>
        </div>
        <span className="flex items-center gap-1.5 font-mono text-2xs text-accent">
          <span className="ari-pulse size-1.5 rounded-full bg-accent" aria-hidden="true" />
          <ElapsedSeconds startedAt={startedAt} />
        </span>
      </div>

      <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-center gap-4 p-3">
        <div className="ari-image-generation-canvas" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <span key={index} />
          ))}
          <ImageIcon className="ari-image-generation-mark" size={22} />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-fg">Composing pixels</p>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
            Building composition, light, and detail. This can take a minute.
          </p>
          {prompt !== null ? (
            <p className="mt-2 line-clamp-2 border-l border-accent/50 pl-2 font-mono text-2xs leading-relaxed text-fg-subtle">
              {prompt}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}
