# Ari

[![Stars](https://img.shields.io/github/stars/j35dev/Ari?style=social)](https://github.com/j35dev/Ari/stargazers) [![Forks](https://img.shields.io/github/forks/j35dev/Ari)](https://github.com/j35dev/Ari/forks) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE) [![Release](https://img.shields.io/github/v/release/j35dev/Ari)](https://github.com/j35dev/Ari/releases) [![Verify](https://github.com/j35dev/Ari/actions/workflows/verify.yml/badge.svg)](https://github.com/j35dev/Ari/actions/workflows/verify.yml) [![Contributors](https://img.shields.io/github/contributors/j35dev/Ari)](https://github.com/j35dev/Ari/graphs/contributors)

**Ari is an open, local-first agent development environment (ADE)** for Windows, macOS and Linux.

Ari is a fast, beautiful control surface for the coding agents already installed and
authenticated on your machine: Claude Code, Codex, OpenCode, Grok, Pi, Hermes. A built-in
harness (**Ari Core**) turns any OpenAI/Anthropic/Ollama-compatible endpoint into a full
coding agent. No accounts. No OAuth flows. No cloud middleman: sessions, journals and
checkpoints live on your disk.

<img width="1917" height="1015" alt="Ari desktop" src="https://github.com/user-attachments/assets/4bfd4225-4628-4a35-bcb9-08db759068d9" />

> Status: **beta.** Expect rough edges, and please [report them](https://github.com/j35dev/Ari/issues).

Aria, the shared coordinator chat, is an optional experiment. Enable it in
**Settings → Experimental → Aria**. It is off by default; chat history and saved
choices are preserved. General dictation works independently of this setting.

## Contents

- [Install](#install)
- [Why Ari](#why-ari)
- [Features](#features)
- [Supported agents](#supported-agents)
- [Quick start](#quick-start)
- [Remote control from your phone](#remote-control-from-your-phone)
- [Build from source](#build-from-source)
- [Architecture](#architecture)
- [Development](#development)
- [Star history](#star-history)
- [Project status](#project-status)
- [Contributing](#contributing)
- [License](#license)

## Install

Download the file for your system from the [latest release](https://github.com/j35dev/Ari/releases/latest):

| System                | File                               |
| --------------------- | ---------------------------------- |
| Windows 10/11 (x64)   | `Ari-Setup-<version>.exe`          |
| macOS (Apple / Intel) | `Ari-<version>-universal.dmg`      |
| Linux (x64)           | `Ari-<version>.deb` or `.AppImage` |

Ari is open source and its builds are **not signed with a paid certificate**, so
each system warns you the first time:

- **Windows.** SmartScreen says "Windows protected your PC". Click **More info → Run
  anyway**. The warning appears because the installer has no code-signing certificate,
  not because anything was found in it.
- **macOS.** The app is ad-hoc signed but not notarized by Apple. Drag Ari to
  Applications, then right-click it and choose **Open** (on macOS 15 and later, open it
  once, then use **System Settings → Privacy & Security → Open Anyway**). Or clear the
  download flag in Terminal: `xattr -cr /Applications/Ari.app`. Ari can't update itself
  on macOS: when a new version is out it links you to the release to download.
- **Linux.** Prefer the `.deb` (`sudo apt install ./Ari-<version>.deb`). The AppImage
  needs FUSE 2 (`sudo apt install libfuse2`, or `libfuse2t64` on Ubuntu 24.04), and on
  Ubuntu 24.04 and later AppArmor's user-namespace restriction stops it from starting
  its sandbox, which the `.deb` sets up for you.

On Windows and Linux, Ari offers each new release and installs it when you restart.

**Where your data lives.** Settings, sessions, worktrees Ari creates, and in-app browser
data are in the app's profile folder:

| System  | Profile folder                      |
| ------- | ----------------------------------- |
| Windows | `%APPDATA%\Ari`                     |
| macOS   | `~/Library/Application Support/Ari` |
| Linux   | `~/.config/Ari`                     |

Warnings and errors are logged to `triage/logs.jsonl` inside it; that is what
[Ari Triage](#ari-triage) reads and what `ari triage --export` packages.

**Uninstalling.** On Windows use **Settings → Apps → Ari → Uninstall**; on macOS move
`Ari.app` to the Trash; on Linux remove the `.deb` package with your package manager,
or delete the AppImage.
Uninstalling keeps your data. To remove it too, delete the profile folder above.

**Privacy.** Ari has no telemetry or analytics SDK and needs no account. It talks to the
network for what you use (your agents, the model endpoints you add, the phone
connection) plus a few background checks: GitHub for Ari updates, models.dev for model
lists, and the npm registry for agent CLI versions. Discord Rich Presence is **on by
default**: with the Discord desktop app running it shows "Running N agents" or "Idle"
and how long Ari has been open, nothing about your projects. Turn it off in
**Settings → Notifications → Discord status**.

## Why Ari

Coding agents became powerful CLIs, and typing into one terminal at a time is the
bottleneck. Ari wraps the agents you already have in a real desktop environment:

- **Drive many agents at once.** Every installed CLI is detected automatically and driven
  through its native protocol (ACP where available, structured CLI fallbacks elsewhere).
  Your existing logins are reused: Ari never asks you to re-authenticate.
- **A real terminal room.** A full-page terminal workspace with herdr-style panes: split
  any pane right or down, drag dividers (or nudge them with arrow keys), and run Claude
  Code in one pane while Codex runs in another, everything staying live in the background.
- **Sessions you can trust.** Every turn is appended to an event-sourced journal with
  git-backed checkpoints, so you can review, revert a single turn, or resume exactly
  where an agent left off.
- **Review and ship without leaving.** A Changes pane shows the worktree diff per turn,
  checkpoints can be reverted individually, and a ship flow stages, commits and opens PRs.

## Features

| Area       | What you get                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents     | Claude Code, Codex, OpenCode, Grok, Pi, Hermes: auto-detected; any OpenAI/Anthropic/Ollama-compatible endpoint via Ari Core                  |
| Terminals  | Full-page pane workspace: binary splits, draggable/keyboard dividers, agent-CLI launcher, per-pane scrollback that survives remounts         |
| Sessions   | Event-sourced journals, realtime streaming deltas, session resume, edit-and-resend                                                           |
| References | `@file` mentions with a ranked popup; drag files from the explorer or Changes list straight into the prompt                                  |
| Review     | Per-turn diffs, checkpoint list with per-turn revert, worktree status                                                                        |
| Ship       | Stage → commit → push → PR in one flow                                                                                                       |
| Models     | Cross-provider model picker with live catalogs, per-session lock after first turn                                                            |
| Desktop    | Command palette, prompt stash, usage dashboard (ccusage), file explorer with editor, theme engine                                            |
| Phone      | Installable PWA that drives sessions from anywhere: prompts, queues, approvals with the provider's own choices, interruptions, live activity |

## Ari Triage

Choose **Triage an Ari issue** from the command palette, **Triage an issue** in
Settings → Advanced, or **Report with Triage** beside an error. Describe the
problem, review the diagnostic context, and select your agent. Each case has its
own workspace and stays available for follow-ups.

You can also type `/ari triage` or `/ari triage <what went wrong>` in a local
agent conversation. The slash menu lists it alongside `/ari theme`. It opens
triage with the current agent, model, effort, and permissions; review the
diagnostics and start the investigation there. The current project conversation
stays intact. Add screenshots in the triage conversation after starting it.

The agent can prepare an editable issue for `j35dev/Ari`, or work on a fix in a
separate source checkout. Triage runs `pnpm verify` against the fix before it can
publish a draft PR. It uses your connected GitHub account, creating a contributor
fork when needed. You review the public draft, account, and changes before
publishing. Installing a fixed Ari build is a separate action.

If Ari cannot start, the bundled CLI can export diagnostics or launch an installed
Claude Code or Codex independently:

```sh
ari triage --export
ari triage --agent codex
ari triage --agent claude --profile /path/to/affected/Ari/profile
```

When the `ari` CLI launcher is not on your terminal PATH, run the same commands
with Node against the installed `resources/agent-cli/ari.cjs` script. Terminal
agent launches exclude logs by default; diagnostic exports include recent
sanitized warnings and errors. The affected app version is read from its saved
profile metadata and is reported as unknown when unavailable.

## Supported agents

| Agent       | Transport                 | Notes                                                |
| ----------- | ------------------------- | ---------------------------------------------------- |
| Claude Code | ACP + CLI fallback        | Detected via `claude` on PATH                        |
| Codex CLI   | App-server + CLI fallback | Detected via `codex` on PATH                         |
| OpenCode    | ACP + CLI fallback        |                                                      |
| Grok CLI    | ACP + CLI fallback        |                                                      |
| Pi          | ACP + CLI fallback        |                                                      |
| Hermes      | ACP + CLI fallback        |                                                      |
| Qoder CLI   | Native ACP                | Optional; uses the existing Qoder login              |
| Muse Code   | Native ACP                | Optional; Muse account; upstream ACP is experimental |
| Antigravity | Native ACP                | Optional; installed `agy`; Gemini models in Ari      |
| Ari Core    | Direct harness            | Any OpenAI/Anthropic/Ollama-compatible endpoint      |

Claude Code, Codex, Grok, and OpenCode are enabled by default. Enable Qoder, Muse Code,
Antigravity, Pi, or Hermes in **Settings → Providers** when you want to use them.
Optional providers have installer actions and executable-path settings. Existing saved
enable/disable choices are preserved. Ari Core uses the API endpoints you add yourself.

An agent you don't use stays out of the model picker; a disabled provider is never launched
or probed. Native ACP providers reuse their own logins and discover models and reasoning
levels from the installed runtime. Qoder uses `qoder login`; Muse uses `muse login`;
Antigravity uses `agy acp --login`. Antigravity runs the user's official CLI through
the [documented ACP interface](https://antigravity.google/docs/cli/acp/), with Ari's own
client identity. Google currently limits third-party models to named ACP clients, so
Ari offers Gemini models and refuses unsupported selections. See the
[integration and terms review](ANTIGRAVITY.md).

## Quick start

Prerequisites: **Node ≥ 22.13** (pnpm needs it) and **pnpm**. CI and the
lockfile are pinned to the version in `packageManager`, so `corepack enable`
picks the right one up for you.

```sh
git clone https://github.com/j35dev/Ari.git
cd Ari
pnpm install               # electron and esbuild download their binaries; no
pnpm dev                   # approve-builds step is needed
```

`pnpm-workspace.yaml` already allows the three packages that need install
scripts (`electron`, `esbuild`, `electron-winstaller`), so `pnpm install` runs
them itself. The terminal's pty comes from `@lydell/node-pty` prebuilt
binaries, which have no install script at all.

`pnpm dev` runs as **Ari Dev** with its own profile (Windows: `%APPDATA%\Ari Dev`),
so it can sit next to an installed Ari. Sessions and settings are not shared.

First launch detects installed CLIs automatically; anything missing is simply not
offered. Point Ari at a project folder and start a session.

## Remote control from your phone

A paired phone is a remote control for the desktop: it creates sessions, sends
prompts and follow-ups, answers approvals with the provider's exact choices,
interrupts turns, and watches the conversation, while the agents keep running
on the computer. Closing the phone changes nothing about the work.

Two independent ways to reach the desktop; neither needs the other:

| Mode        | Setup                                                                            | Needs an account |
| ----------- | -------------------------------------------------------------------------------- | ---------------- |
| Tailscale   | Install Tailscale on both devices, then Settings → Remote → Enable, Enable Serve | No               |
| Ari Connect | An invitation to the hosted service, then Settings → Remote → Managed connection | Yes              |

For the self-hosted path, the desktop publishes its gateway on your tailnet and
serves the phone's app from that same address, so nothing leaves your devices.
Because both ends are on the tailnet, the phone can be on cellular while the
computer is on home Wi-Fi.

Every device is approved at the computer, by name and a short confirmation
code, and each approval carries a project grant: a phone reaches only the
projects you picked, and revocation is immediate. The phone's key never leaves
it: pairing stores a non-extractable browser key, not a password.

See [`apps/mobile/README.md`](./apps/mobile/README.md) for the phone side,
including installation and what to check when a connection fails.

## Build from source

Installers are produced with [electron-builder](https://www.electron.build); the config
lives in [`apps/desktop/electron-builder.yml`](./apps/desktop/electron-builder.yml).
From the repo root:

```sh
pnpm install
pnpm --filter @ari/desktop build             # renderer + main bundles
pnpm --filter @ari/mobile build              # phone PWA, packed into the installer
cd apps/desktop
pnpm exec electron-builder --win --x64       # NSIS installer  → dist/Ari-Setup-<version>.exe
pnpm exec electron-builder --mac             # universal DMG    (needs macOS)
pnpm exec electron-builder --linux --x64     # AppImage + deb   (needs Linux)
```

Native modules use the locked Node-API prebuilds; do not run `install-app-deps` or
override the packaging configuration's disabled native rebuild.

Bundles land in `dist/`. Windows builds are unsigned unless signing env vars
(`CSC_LINK` / `CSC_KEY_PASSWORD`) are set; macOS builds are ad-hoc signed and not
notarized. Before a release, regenerate the bundled license notices with
`node scripts/third-party-notices.mjs`.

## Architecture

A pnpm monorepo of small, strict packages:

| Package          | Role                                                                            |
| ---------------- | ------------------------------------------------------------------------------- |
| `@ari/contracts` | Zod schemas + typed RPC channel definitions: parse, don't validate twice        |
| `@ari/shared`    | Result types, JSONL utilities, logger: the boring, load-bearing code            |
| `@ari/ui`        | Design system: tokens, primitives, motion                                       |
| `@ari/providers` | Driver registry: ACP transports, CLI adapters, detection, model catalogs        |
| `@ari/engine`    | Sessions, event-sourced journals, git service (diffs, checkpoints, worktrees)   |
| `@ari/ari-core`  | The built-in harness: any OpenAI/Anthropic/Ollama endpoint becomes a full agent |
| `apps/desktop`   | The Electron shell: sandboxed renderer, typed IPC, React UI                     |

Design invariants worth knowing before you dig in:

- **Event-sourced everything.** A session is an append-only journal; the UI is a fold over
  it, so replay is deterministic and resume is free.
- **The renderer is sandboxed.** Every privileged operation is a typed RPC handled in the
  main process; the file explorer and editor are jailed to the workspace.
- **One adapter interface.** Adding an agent means implementing one driver: detection,
  transport and model catalog slot in around it.

## Development

```sh
pnpm install
pnpm dev          # run the desktop app in dev mode
pnpm verify       # typecheck + lint + test across the workspace (required before every commit)
pnpm test:watch   # vitest watch
pnpm format       # prettier write
```

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development and pull-request guidelines.

## Star history

[![Star History Chart](https://api.star-history.com/svg?repos=j35dev%2FAri&type=Date)](https://www.star-history.com/#j35dev/Ari)

A star on the repo genuinely helps: it is how new users discover Ari, and it keeps
the project visible while it is still moving fast.

## Project status

Installers for each platform are available from [Releases](https://github.com/j35dev/Ari/releases).

## Contributing

Issues and PRs are welcome: see [CONTRIBUTING.md](./CONTRIBUTING.md). For substantial
changes, open an issue first to discuss the scope. Keep diffs small, match the existing
style, and make sure `pnpm verify` is green before pushing.

## License

[MIT](./LICENSE). Ari ships third-party packages under their own licenses, listed in
[`THIRD_PARTY_NOTICES.txt`](./THIRD_PARTY_NOTICES.txt) (also in the app's `resources`
folder).
