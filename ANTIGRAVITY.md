# Antigravity provider

Reviewed on 2026-11-24 against Antigravity CLI 1.5.7.

## Setup and transport

Enable Antigravity in Settings → Providers. Ari discovers `agy` on PATH,
`~/.local/bin/agy` on Unix, or `%LOCALAPPDATA%/agy/bin/agy.exe` on Windows.
An explicit executable path takes precedence. The Antigravity IDE launcher is
not the coding CLI.

Ari launches the user's installed, unmodified CLI with `agy acp`, using ACP v1
JSON-RPC over stdin/stdout. No Python SDK or model proxy is involved. AGY owns
authentication, credentials, and its tools. Ari supplies its own `ari` client
identity and its browser MCP server; it does not impersonate another editor.
When the agent offers no runnable login metadata, Ari launches the documented
`agy acp --login` command.

Models and reasoning levels come from live session config options. Ask uses the
agent's default permission mode; Edits uses accept-edits; Full uses the CLI's
permission bypass flag only for that explicitly selected session. Background
discovery and login probes never receive that flag. Approvals, cancellation,
streaming, and session resume use Ari's existing ACP transport.

## Third-party client restrictions

Google's [ACP guide](https://antigravity.google/docs/cli/acp/) explicitly describes
editors launching `agy acp` as a subprocess. Its
[other editors guide](https://antigravity.google/docs/ide/extensions/acp/) says ACP
can be used in any supporting editor and documents a community VS Code client.
This is direct documentation for the transport Ari implements.

There is a concrete model restriction in that guide: Gemini models are available
in every client, while third-party models are offered only to JetBrains IDEs
(including Air), Android Studio, Android Performance Analyzer, Zed, and Xcode.
Ari is not on that list. Ari filters its live and restored Antigravity catalogs
to Gemini models, rejects explicit third-party picks, and replaces a non-Gemini
CLI default with an offered Gemini model before sending a prompt. An unavailable
Gemini selection fails instead of falling back to another model.

Section 6 of [Antigravity's additional terms](https://antigravity.google/terms)
still contains broad wording restricting third-party software accessing the
service, with OpenClaw using Antigravity OAuth as its example and account
suspension as a possible consequence. The terms do not expressly name Ari or
carve out all CLI wrappers. Thus this review cannot guarantee that every form
of third-party orchestration is unrestricted.

A [Google AI Developers Forum reply](https://discuss.ai.google.dev/t/is-it-allowed-for-an-open-source-tool-to-call-the-official-agy-cli-in-headless-mode/183429/2)
states that local official CLI invocation is allowed when credentials are not
extracted or intercepted. The author's visible role is Regular, not an identified
Google employee; this is supporting discussion, not a binding Google exception.
The official ACP documentation is the primary evidence supporting this integration.
Normal account eligibility, subscription quotas, rate limits, and enterprise
administrator policies continue to apply.

## Validation

An optional live test runs against the installed CLI and its own sign-in:

```powershell
$env:ARI_REAL_AGY = 'C:/path/to/agy.exe'
pnpm --filter @ari/providers exec vitest run src/antigravity/live.test.ts --maxWorkers=1
```

The test uses a disposable workspace and real Gemini quota. It checks system
instructions, streamed tool events, file creation, and persisted conversation
resume. It answers any approval requests the user's CLI settings produce;
separate transport fixtures verify approval responses in all three permission
modes. Routine tests do not invoke the live provider.
