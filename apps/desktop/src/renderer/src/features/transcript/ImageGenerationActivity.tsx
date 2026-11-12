import { useMemo, useState } from 'react'
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

/**
 * Live state for slow image tools, mounted when generation begins: the same
 * live line any running work gets (working ring, what is happening, elapsed
 * time), with the prompt hanging beneath it on the step hairline.
 */
export function ImageGenerationActivity({ call }: { call: TranscriptBlock }) {
  const [startedAt] = useState(() => Date.now())
  const prompt = useMemo(() => promptPreview(call), [call])

  return (
    <section aria-label="Generating image" aria-live="polite" className="ari-image-generation my-1">
      <div className="flex min-h-7 items-center gap-2.5 text-sm text-fg-muted">
        <span className="ari-status" data-status="working" aria-hidden="true" />
        <p>Rendering your image</p>
        <span className="text-[13px]">
          <ElapsedSeconds startedAt={startedAt} />
        </span>
      </div>
      <div className="ml-1.5 mt-0.5 border-l border-border-strong py-1 pl-4 text-[13.5px] leading-relaxed text-fg-subtle">
        {prompt !== null ? <p className="line-clamp-2 max-w-[620px]">{prompt}</p> : null}
        <p>This can take a minute.</p>
      </div>
    </section>
  )
}
