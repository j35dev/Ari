# Ari

**Ari** — a simple, open desktop **agent development environment (ADE)**.

Ari is a fast, beautiful control surface for the coding agents already installed and
authenticated on your machine — Claude Code, Codex, OpenCode, Grok, Pi, Hermes — plus a
built-in harness (**Ari Core**) that turns any OpenAI/Anthropic/Ollama-compatible endpoint
into a full coding agent. No accounts. No OAuth flows. Local-first by construction.

> Status: **pre-alpha, under active construction.** See [PLAN.md](./PLAN.md) for the full
> build plan and [PROGRESS.md](./PROGRESS.md) for live progress.

## Principles

1. **Zero friction** — launch, agents detected, working. Ari reuses your existing CLI logins.
2. **Premium UI/UX** — solid layered surfaces, a real theme engine, choreographed motion.
3. **Honest architecture** — event-sourced sessions, typed contracts, one adapter interface.
4. **Agent-buildable** — every task is commit-sized, verifiable, and resumable.

## Platform

Windows · macOS · Linux (Electron + React + TypeScript).

## Development

```sh
pnpm install
pnpm dev        # run the desktop app in dev mode
pnpm verify     # typecheck + lint + test across the workspace
```

## License

[MIT](./LICENSE)
