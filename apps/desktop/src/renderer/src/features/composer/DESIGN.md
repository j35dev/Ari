# Composer + model picker

## Design read

- **Surface:** developer-tool application UI (Electron ADE).
- **Audience:** developers who switch agents and models mid-thread, keyboard-first, often under time pressure.
- **Single job:** write a turn and see which agent + model will run it, without leaving the box.
- **Task / risk:** high-frequency; wrong agent or permission mode wastes a turn and possibly the worktree. Empty, loading, no-match, and disabled send must be honest.
- **Content:** model labels vary (`Sonnet 4.5` vs `Anthropic Claude Haiku Latest`); 2–7 agents; optional context-window hint; permission is three short labels.
- **Platform:** desktop window, pointer + keyboard, popover must not trap the session chrome.
- **Constraints:** reuse `@ari/ui` tokens, Geist, lucide, existing `Popover`/`Input` patterns; no new icon pack; no T3 clone.

## Evidence

- Local: M22 cloned T3 (provider-chip pill, left send, `focus-within` halo, icon rail in an earlier pass). Neighbors use ghost chips, `rounded-lg`, `focus-visible` rings, Geist, glass overlays.
- Contrast: T3 (icon rail, starred recents, Ctrl+N, left send) and Cursor (right circular send). Ari is agent-first, not model-marketplace-first.
- Inference: users pick an *agent* then a model; the chrome should say that.

## Thesis

One glass plate. Identity is a **mono letter mark** (C Claude, X Codex, O OpenCode, A Ari Core) plus the model name — not an all-caps vendor chip and not a logo rail. Context (agent, permission) sits left; prompt actions (stash, send) sit right. Send is a rounded-md square, not a circle, so it shares geometry with the chips. No leftover `focus-within` halo after clicking a chip; keyboard rings stay on `:focus-visible`.

## Semantic reuse

- Color: `bg-glass-input`, `border-border`, `bg-surface-2` hover/active, `bg-accent` only on an armed send, `text-fg-subtle` for marks/hints.
- Type: Geist UI + Geist Mono for the mark and hints.
- Radius: plate `rounded-lg`; chips/send `rounded-md`; mark `rounded-sm`.
- Motion: named `transition-colors` / `transition-transform`; chevron rotates; `motion-reduce:transition-none`.
- Icons: lucide (`Search`, `ChevronDown`, `Check`, `ArrowUp`, `Square`, `Bookmark`).

## Anti-defaults kept / rejected

- No emoji, no hover lift, no `transition: all`, no tint-on-tint selected rows (check mark + `surface-2` active).
- Rounded-md chips stay because they share geometry with send, not as a marketing badge row.
- Letter mark belongs because Ari’s job is *which agent*, and letters stay readable at 20px without vendor logos.

## States

- Composer: empty (placeholder, send disabled), typing (send armed), running (stop), queued banner, slash/mention popovers, stash empty/full, disabled.
- Picker: closed, open + loading, grouped list, search filter, no-match, selected + keyboard active, Escape / outside pointer close.
- Permission: Ask / Edits / Full auto, current indicated, keyboard focus-visible.
- Pointer vs keyboard: chips and send use `:focus-visible` only; plate has no `:focus-within` halo.
- Narrow: hints dropped; trigger truncates; menu `w-72` can shift.

## Critique (source + tests; live capture unverified)

Score **21/24**. 2s: specificity, hierarchy, composition, consistency, type, material, state, motion, authenticity, distinctiveness. 1s: responsive (no 320px capture), accessibility (roles/keyboard tested; contrast and AT unverified). No zeros. Contract: keyboard pass; contrast/AT unverified — not a WCAG claim.
