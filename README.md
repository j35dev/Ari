# Ari

**Ari** — an open, local-first **agent development environment (ADE)** for Windows, macOS and Linux.

Ari is a fast, beautiful control surface for the coding agents already installed and
authenticated on your machine — Claude Code, Codex, OpenCode, Grok, Pi, Hermes — plus a
built-in harness (**Ari Core**) that turns any OpenAI/Anthropic/Ollama-compatible endpoint
into a full coding agent. No accounts. No OAuth flows. No cloud middleman: sessions,
journals and checkpoints live on your disk.
<img width="1597" height="990" alt="Screenshot 2026-08-30 062458" src="https://github.com/user-attachments/assets/90b250d0-7530-4e78-b20c-56299873064d" />


> Status: **pre-alpha, under active construction.** See [PLAN.md](./PLAN.md) for the build
> plan and [PROGRESS.md](./PROGRESS.md) for live, task-by-task progress.

## Why Ari

Coding agents became powerful CLIs — and typing into one terminal at a time is the
bottleneck. Ari wraps the agents you already have in a real desktop environment:

- **Drive many agents at once.** Every installed CLI is detected automatically and driven
  through its native protocol (ACP where available, structured CLI fallbacks elsewhere).
  Your existing logins are reused — Ari never asks you to re-authenticate.
- **A real terminal room.** A full-page terminal workspace with herdr-style panes: split
  any pane right or down, drag dividers (or nudge them with arrow keys), and run Claude
  Code in one pane, Codex in another, while everything stays live in the background.
- **Sessions you can trust.** Every turn is appended to an event-sourced journal with
  git-backed checkpoints, so you can review, revert a single turn, or resume exactly
  where an agent left off.
- **Review and ship without leaving.** A Changes pane shows the worktree diff per turn,
  checkpoints can be reverted individually, and a ship flow stages, commits and opens PRs.

## Features

| Area | What you get |
| --- | --- |
| Agents | Claude Code, Codex, OpenCode, Grok, Pi, Hermes — auto-detected; any OpenAI/Anthropic/Ollama-compatible endpoint via Ari Core |
| Terminals | Full-page pane workspace: binary splits, draggable/keyboard dividers, agent-CLI launcher, per-pane scrollback that survives remounts |
| Sessions | Event-sourced journals, realtime streaming deltas, session resume, edit-and-resend |
| References | `@file` mentions with a ranked popup; drag files from the explorer or Changes list straight into the prompt |
| Review | Per-turn diffs, checkpoint list with per-turn revert, worktree status |
| Ship | Stage → commit → push → PR in one flow |
| Models | Cross-provider model picker with live catalogs, per-session lock after first turn |
| Desktop | Command palette, prompt stash, usage dashboard (ccusage), file explorer with editor, theme engine |

## Supported agents

| Agent | Transport | Notes |
| --- | --- | --- |
| Claude Code | ACP + CLI fallback | Detected via `claude` on PATH |
| Codex CLI | App-server + CLI fallback | Detected via `codex` on PATH |
| OpenCode | ACP + CLI fallback | |
| Grok CLI | ACP + CLI fallback | |
| Pi | ACP + CLI fallback | |
| Hermes | ACP + CLI fallback | |
| Ari Core | Direct harness | Any OpenAI/Anthropic/Ollama-compatible endpoint |

An agent you don't use simply stays unlisted — detection is passive and offline.

## Quick start

Prerequisites: **Node ≥ 22** and **pnpm**.

```sh
git clone https://github.com/tahacore/Ari.git
cd Ari
pnpm install
pnpm approve-builds        # once — approves the node-pty native postinstall
pnpm dev                   # launch the desktop app
```

First launch detects installed CLIs automatically; anything missing is simply not
offered. Point Ari at a project folder and start a session.

## Build from source

Installers are produced with [electron-builder](https://www.electron.build); the config
lives in [`apps/desktop/electron-builder.yml`](./apps/desktop/electron-builder.yml).
From the repo root:

```sh
pnpm install
pnpm approve-builds                          # once, for node-pty
pnpm --filter @ari/desktop build             # renderer + main bundles
cd apps/desktop
npx electron-builder install-app-deps        # rebuild node-pty for Electron's ABI
npx electron-builder --win                   # NSIS installer  → dist/Ari-Setup-<version>.exe
npx electron-builder --mac                   # universal DMG    (needs macOS)
npx electron-builder --linux                 # AppImage + deb   (needs Linux)
```

Bundles land in `dist/`. Code signing is scaffolded but optional — unsigned builds work;
signing env vars (`CSC_LINK` / `CSC_KEY_PASSWORD`) are picked up automatically when set.

## Architecture

A pnpm monorepo of small, strict packages:

| Package | Role |
| --- | --- |
| `@ari/contracts` | Zod schemas + typed RPC channel definitions — parse, don't validate twice |
| `@ari/shared` | Result types, JSONL utilities, logger — the boring, load-bearing code |
| `@ari/ui` | Design system: tokens, primitives, motion |
| `@ari/providers` | Driver registry: ACP transports, CLI adapters, detection, model catalogs |
| `@ari/engine` | Sessions, event-sourced journals, git service (diffs, checkpoints, worktrees) |
| `@ari/ari-core` | The built-in harness: any OpenAI/Anthropic/Ollama endpoint becomes a full agent |
| `apps/desktop` | The Electron shell: sandboxed renderer, typed IPC, React UI |

Design invariants worth knowing before you dig in:

- **Event-sourced everything.** A session is an append-only journal; the UI is a fold over
  it, so replay is deterministic and resume is free.
- **The renderer is sandboxed.** Every privileged operation is a typed RPC handled in the
  main process; the file explorer and editor are jailed to the workspace.
- **One adapter interface.** Adding an agent means implementing one driver — detection,
  transport and model catalog slot in around it.

## Development

```sh
pnpm install
pnpm dev          # run the desktop app in dev mode
pnpm verify       # typecheck + lint + test across the workspace (required before every commit)
pnpm test:watch   # vitest watch
pnpm format       # prettier write
```

`AGENTS.md` documents the working protocol (branching, commit conventions, the
task-by-task workflow) — it doubles as a contributor guide and is enforced by tooling.

## Project status

Ari is built in the open, milestone by milestone. Current state and history:

- [PLAN.md](./PLAN.md) — the architecture and milestone plan
- [PROGRESS.md](./PROGRESS.md) — every shipped task with its design notes
- [Releases](https://github.com/tahacore/Ari/releases) — installers for each platform

## Contributing

Issues and PRs are welcome. For substantial work, open an issue first so it can be slotted
into the plan. Keep diffs small, match the existing style, and make sure `pnpm verify` is
green before pushing.

## License

[MIT](./LICENSE)
