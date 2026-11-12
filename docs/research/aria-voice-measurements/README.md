# Aria voice implementation evidence

The final implementation continues `feat/aria-voice` from `a5f5b7f3`; it does not rebuild the research baseline. The inherited uncommitted pronunciation/cloud changes and successful utility result were committed as `dcd2ca21` before further work.

`checkpoint-dcd2ca21/` preserves the inherited CPU, DirectML and utility measurements. The original check logs are retained locally in `../aria-voice-checks/checkpoint-dcd2ca21/`, and the original auditions in `D:/Projects/Ari-aria-voice-spike/samples-v2/checkpoint-dcd2ca21/`. The coordinator's separate replacement snapshot is also preserved.

The top-level measurements are refreshed because the current source fixes native PCM copying, decimal/domain sentence boundaries, provider limits after pronunciation expansion, immediate decode cancellation, final-message isolation, warmed hardware calibration, the missing everyday word “details,” and recognition of sherpa's actual `OOV word skipped` warning. Earlier evidence is a checkpoint, not a claim that it tested the final source.

All heavy steps use `D:/Projects/Ari-machines/scripts/coordination/run-heavy.mjs`, with this voice worktree as the working directory. Checks use one test worker and no file parallelism. The wrapper and native workers run below normal priority, and its shared resource gates are honored. No other lease owner is stopped.

- `verification.json` records the exact final static-check commands, source checkpoint and exit codes. Full logs remain locally in `../aria-voice-checks/`.
- `cpu-t4.json` and `cpu-t2.json` report native CPU synthesis using production spoken-text preparation. First audio is measured after model preload and inference warmup; RTF is generation wall time divided by generated audio duration. CPU is average logical cores busy during synthesis. Memory numbers ending in `MB` in the harness are MiB. Peak RSS includes the benchmark process, checksum validation and native inference, rather than just the model weights.
- `dml-t1.json` records whether this installed Windows runtime exports the DirectML provider entry point. An unavailable result is not a GPU benchmark or CPU timing relabeled as acceleration.
- `utility-smoke.json` exercises the actual rebuilt Electron utility entry point in the isolated `.voice-smoke` profile. It checks copied PCM transport, ordinary names/initialisms/numbers, unknown-word spell-out, stale requests and in-flight cancellation. `preloadMs` includes verification, load and warmup; `firstAudioMs` measures a short first clause after preload. Electron utility memory fields are reported in KiB by Electron.

The harnesses reuse model files from the approved spike and verify all four SHA-256 hashes against the production download manifest. This avoids an unnecessary new 360 MB download. Auditions are generated into `D:/Projects/Ari-aria-voice-spike/samples-v2/`; audio is validated as finite, non-silent PCM, but was not judged by ear.

The negative regression test uses the exact missing-word warning observed in the original spike. Both native harnesses reject that warning, even if sherpa otherwise exits successfully. Word coverage is also asserted before native synthesis.
