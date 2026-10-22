# Perf harness

Measures the real built desktop app over CDP: cold start, session switching, streaming with
typing, main-process responsiveness and memory. No provider credits are spent: turns run on
Ari Core against a local fake OpenAI-compatible endpoint that streams markdown at a fixed rate.

```sh
node scripts/perf/run.mjs --app <worktree> --label <name> --out D:\tmp\ari-perf [--runs 3] [--build]
```

The scripts can measure any worktree: run them from a checkout that has `scripts/perf/` and
point `--app` at the one to measure. It builds `apps/desktop/out` when missing (or with
`--build`; it warns when sources are newer than `out/`) and runs Electron's postinstall if a
fresh `pnpm install` skipped it. Results go to `<out>/<label>/results.json` (raw values and
summaries) and `summary.md`; the table is also printed.

| option                                    | default             |                                                                                |
| ----------------------------------------- | ------------------- | ------------------------------------------------------------------------------ |
| `--runs`                                  | 3                   | measured repetitions per metric (cold start adds one discarded warm-up launch) |
| `--no-throttle`                           | off                 | skip the `Emulation.setCPUThrottlingRate` pass                                 |
| `--throttle-rate`                         | 4                   | CPU slowdown for the throttled pass (renderer only)                            |
| `--stream-seconds`, `--tokens-per-second` | 20, 50              | fake reply length and rate                                                     |
| `--long-turns`                            | 300                 | turns in each long session                                                     |
| `--theme`, `--wallpaper`                  | redline, anime-city | appearance of the scratch profile                                              |
| `--window`                                | 1400x820            | window size                                                                    |
| `--keep-profile`                          | off                 | leave the scratch profile for inspection                                       |

## What it does

1. Seeds a scratch profile `%APPDATA%\Ari Perf <pid>` through the target worktree's own
   stores (bundled with its esbuild): a project, the fake endpoint, CLI providers and
   notifications off, 30 filler sessions, a 3-turn session, and per run one long session
   (markdown, lists, tables, fenced code incl. code inside lists, tool calls; text split into
   small parts like real journals) and one 40-turn session to stream into.
2. Launches the app with that identity: `"Ari Dev"` in `out/main/index.js` is swapped for the
   scratch name until the window exists, then restored. Main starts under `--inspect-brk`; at
   its first line a session preload is registered that installs `probe.js` in the page before
   any app script. The time main spends held by the harness is subtracted from launch times.
3. Measures, then kills only its own process tree and deletes the scratch profile.

## Metrics

- `coldStart.*`: spawn → first contentful paint, → "New session" button mounted, → that button
  hit-testable (launch splash gone; the splash has a 3.2 s minimum by design).
- `switch.*`: real mouse click on a sidebar row (found by title) → first painted frame in which
  the target transcript's last message is laid out (`paint`), and → end of the last long task
  that followed (`settled`), with long-task count/total. `shortToLongFirst` opens a long session
  for the first time, `longToShort` leaves it, `shortToLongRevisit` returns to it.
- `stream.*`, sampled from the first to the last streamed token: long tasks, rAF frame deltas,
  typing latency (CDP key every 200 ms into the composer; keydown → frame painted after the
  `input` event), `pingRpc` (renderer → main `ping` round trip every 250 ms) and
  `mainLoopDelay` (main-process `monitorEventLoopDelay`, 10 ms resolution; on Windows its
  floor is the 15.6 ms timer tick, so read the p95/max).
- `memory.*`: renderer JS heap, and working set / private bytes over the whole process tree,
  after startup and after all scenarios.

Numbers are only comparable on the same machine under similar load; `results.json` records
machine CPU busy % sampled every 5 s. Run baseline and candidate back to back.
