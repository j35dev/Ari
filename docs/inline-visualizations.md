# Inline reply visualizations

Ari can render 15 kinds of visualization directly in an agent's answer, on
desktop and mobile. Agents opt in with a top-level `ari-viz` JSON fence. No
separate web page or file is needed for an inline visual.

Charts include bar, line, area, scatter, pie, donut, radar, heatmap, treemap,
and funnel. Structured visuals include node/edge diagrams, timelines,
schedules, metric cards, and comparison tables. Series can be toggled;
marks support mouse and keyboard inspection. Every visual offers its original
data, JSON copying, and expansion through Ari's existing modal.

The agent-facing [Ari skill](../apps/desktop/resources/cli/ari/SKILL.md#inline-visualizations)
lists exact fields, limits, and examples. The [contract](../packages/contracts/src/visualization.ts)
is the validated source of truth. Application instructions advertise the
format to roots, leads, and delegated agents in new provider contexts, and
on every turn for drivers with an application instruction channel. Existing
resumed contexts without that channel can use the format when requested, or
receive the updated instructions when their provider context is reset.

Colors, surfaces, borders, typography, and focus treatment use Ari's existing
tokens. No visualization has its own fixed palette. Existing visuals change
immediately with the theme, including in the expanded view. The same renderer
and stylesheet serve desktop and mobile.

The Markdown parser recognizes actual top-level code nodes, so examples
inside code, lists or quotes remain examples. During streaming an unclosed
fence is a small pending visual; on completion or interruption, valid JSON
renders and invalid JSON shows an inspectable failure. Ordinary Markdown
keeps the desktop's incremental renderer, and appending text after a finished
visual preserves its state. Labels and values are rendered by React; the
format cannot execute scripts, load assets, or override theme colors.

## Development gallery

Run from the repository root:

```sh
pnpm --filter @ari/desktop exec vite src/renderer --host 127.0.0.1 --port 5188 --strictPort
```

Open `http://127.0.0.1:5188/visualizations.html`. This development-only page
uses the actual reply renderer, has examples for all 15 kinds, and supports
every Ari theme. Example numbers are illustrative and labeled as such.
The gallery entry is separate from the packaged application's entry point.

Focused checks:

```sh
pnpm --filter @ari/contracts test -- src/visualization.test.ts
pnpm --filter @ari/ui test -- src/visualization src/themes.test.ts
pnpm --filter @ari/engine test -- src/control-preamble.test.ts
pnpm --filter @ari/desktop test -- src/renderer/src/features/transcript/MarkdownBlock.test.tsx src/renderer/src/features/transcript/markdown-stream.test.ts src/renderer/src/features/transcript/markdown.test.ts src/main/engine-runtime.test.ts
pnpm --filter @ari/mobile test -- src/components/Markdown.test.tsx src/features/session/Conversation.test.tsx src/lib/markdown.test.ts
```
