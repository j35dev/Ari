# Aria voice implementation handoff

Kokoro speech, independent local/Groq input and output choices, short Aria-authored spoken replies, Read aloud, interruption and local fallback are implemented on the existing `feat/aria-voice` branch. The final functional source checkpoint is `1d602e77dbafa978ad45667867ad5a746048a474`. Subsequent commits record measurements and this handoff without changing runtime behavior.

This takeover continued from `a5f5b7f3`. The inherited changes were preserved in `dcd2ca21`, rather than discarded. The prior worker session, the user's main checkout, other worktrees, the installed application/profile and Tailscale Serve were not changed. No agents or sessions were launched, and nothing was pushed or submitted as a PR.

## What works

- Settings → Experimental → Aria contains local Kokoro and Groq speech output, local and Groq Whisper input, voice selection, model download/removal and encrypted Groq key setup. Input selection applies to Aria hold-to-talk and general dictation. Turning Aria off stops playback, unloads the voice utility and disables the experimental cloud route.
- Kokoro is the default output. Heart (`af_heart`) and Michael (`am_michael`) are selectable. System speech, Piper and Kitten are not user-facing options or fallback defaults.
- Holding the Aria shortcut stops existing speech and preloads local Kokoro while the user speaks. Synthesis runs in a separate Electron utility at below-normal priority. The first sentence starts with a short clause; later audio is synthesized one chunk ahead while playback runs. The utility unloads after five idle minutes.
- Automatic speech belongs only to the current human hold-to-talk turn. Typed requests, background turns and routine commentary stay quiet. A Read aloud control is available on Aria assistant messages, including when automatic voice replies are off.
- Esc, another hold, a replacement reply, settings changes and renderer failure stop playback. Generation checks cover queued synthesis, asynchronous decoding, resume and playback acknowledgments. Existing audio ducking is active only while voice playback owns it.
- Groq failures or missing credentials fall back locally with a visible notice. Local inference still requires its downloaded model; a machine whose measured Kokoro RTF is at least one receives a plain suggestion to use Groq instead of attempting stuttering local playback.

## Model download and runtime size

Kokoro reuses `SpeechService`, `downloadFile`, the existing progress events and shared settings download labels/buttons. Four individually pinned assets are downloaded with resumable partial files and SHA-256 checks. Completion is marked only after all assets verify. Removal uses the existing managed-model ownership checks and stops the voice worker first. The input-model chooser filters out the new `tts` model kind.

Storage is the existing application speech-model root, `userData/speech/models/kokoro-82m-v1.0`. This verification used only the isolated D: profile and approved spike files. No large model was downloaded again: all four spike files were hashed against the production manifest.

The download is **359,719,088 bytes: 359.7 MB / 343.1 MiB**. The ONNX weights account for 325,560,556 bytes; the remaining assets are voices, the English lexicon and token definitions. They come from `csukuangfj/kokoro-multi-lang-v1_0` at pinned revision `f7b96bb6bef5c5da4d3aa4f4e0498fbbf62dc78b`. The model is not bundled with Ari.

The measured Windows x64 native runtime payload is **23,161,917 bytes: 23.2 MB / 22.1 MiB**, plus about 65 KB of JavaScript wrappers. Packaging externalizes the native module, unpacks its files from ASAR and excludes other operating systems' payloads. This is the uncompressed installer payload addition; a before/after NSIS installer delta was not built or measured. Universal macOS and Linux packaging rules are present but were not exercised on this Windows host.

## Measurements on this PC

Measured on the i7-10750H, six physical cores / twelve logical cores, 15.91 GiB RAM, Windows, Node 24.13.0, while other shared work was active. Every heavy step honored the shared lease, resource gates and below-normal priority. Tests used one worker and no file parallelism.

First audio below is measured after model load and inference warmup. RTF is synthesis seconds per generated audio second, so values below one keep up on average. CPU is logical cores busy during synthesis. RSS includes the whole benchmark process, checksum buffers and native inference.

| CPU configuration | Model load | Inference warmup | Peak RSS | Cores busy | RTF, realistic replies |
| --- | ---: | ---: | ---: | ---: | ---: |
| Four threads | 2.89 s | 0.94 s | 703.7 MiB | 3.90–3.92 | 0.64–0.73 |
| Two threads | 2.63 s | 1.25 s | 720.2 MiB | 1.92–1.98 | 0.93–0.95 |

| Reply | Four-thread first audio | Two-thread first audio | Generated speech duration, four threads |
| --- | ---: | ---: | ---: |
| Checks ready | 0.859 s | 1.077 s | 3.35 s |
| Outcome and question | 1.126 s | 1.642 s | 3.95 s |
| Fallback with table/chart | 0.939 s | 1.318 s | 5.82 s |
| Agent-name stress test | 0.692 s | 0.992 s | 6.39 s |
| Unknown-word spell-out | 2.031 s | 2.718 s | 4.94 s |

Four threads are retained for this machine. Thread count starts at half the logical cores, capped at four; RAM/core information and a short warmed benchmark are cached with a hardware/model signature. Accelerated providers are considered only when the installed native runtime supports them and a comparison improves inference time by more than 15 percent.

The PC has an NVIDIA GeForce RTX 2060, but **the shipped sherpa-onnx 2.0.1 Windows runtime has no DirectML entry point**. `dml-t1.json` records this unavailable result explicitly; there is no GPU timing or claimed speedup. CoreML and NPU performance were not measured, and this implementation does not ship a separate accelerated runtime.

There is still a material limit to the “instant” goal: sherpa returns completed sentence/clause audio rather than reliable incremental PCM inside a sentence. From the measured chunk timings, the one-chunk-ahead pipeline can leave an estimated **0.43 s gap** in the checks-ready sample and about **2.04 s** in the deliberately long agent-name list. The outcome/question and fallback samples have no estimated synthesis gap at four threads. These are scheduling estimates, not a live renderer audio-capture measurement. The auditions concatenate the generated PCM and therefore do not reproduce those scheduling gaps. Short authored replies and four threads help; continuous low-latency speech under all busy-machine conditions is not established.

## What Aria says

The Aria prompt and bundled CLI protocol ask Aria to put a valid single-line comment first in each final reply:

```text
<!-- aria:speak {"text":"The checks passed. Would you like Pi to handle the mobile polish?"} -->
```

The spoken line is separate from the visible written reply. It has one to three short natural sentences, at most 420 characters, with outcomes, anything needing the user and any direct question. Paths, IDs, lists, code and tables are omitted; numbers are rounded and names use human pronunciations. A complete authored line can start speech while the rest of the written reply is still streaming. Routine progress never carries this marker. The comment is hidden from rendering, copying and quoting.

| Written reply | Spoken reply |
| --- | --- |
| All 28 tests passed; detailed code and a results table follow. | “The checks passed, and the changes are ready for your review.” |
| Codex finished the pairing screen; full implementation details follow. | “Codex finished the pairing screen. Would you like Pi to handle the mobile polish?” |
| No authored line: Ari Connect needs the user; a table and chart follow; “Should I run the checks?” | “Ari Connect is the only project that needs you. I put the details in the chat. Should I run the checks?” |

The fallback condenser uses the outcome and a direct question, leaves structured content in the chat and never reads table cells, code, charts or list entries. Final-message tracking prevents earlier commentary from becoming the fallback outcome. Decimal points and domain names survive sentence splitting.

The local lexicon covers Ari (“AH-ree”), Aria (“AH-ree-uh”), agent names, PR, ACP, CLI and the stock dictionary's missing plural “details.” Numbers, currency, percentages, initialisms and URL domains are normalized. Each emitted English token must exist in the dictionary. Unknown words are spelled out; unsupported scripts or an incomplete letter dictionary fail clearly instead of being silently skipped. Both native harnesses reject sherpa's actual `OOV word skipped` warning, with a negative regression test based on the original spike. Groq receives normalized text with simple pronunciation respellings, and clause limits are enforced after that expansion.

## Groq setup and privacy

The user pastes their own key in Aria settings. `GroqKeyStore` stores only Electron `safeStorage` ciphertext in `speech/groq-key.enc`, exposes configured/encryption status, and refuses unencrypted storage (including Linux `basic_text`). Keys, request bodies and remote error bodies are not logged or stored in plain settings. No key, account creation, live paid requests or cloud audio audition was used here.

Official Groq documentation was checked in the browser on 2026-11-12:

- Input: `whisper-large-v3-turbo`, $0.04 per audio hour; or `whisper-large-v3`, $0.111 per hour. Both support multilingual transcription. Requests upload only the mono 16 kHz WAV recording to `/openai/v1/audio/transcriptions`, with the chosen model and optional language. The documented attachment cap is 25 MB; minimum audio length is 0.01 s and minimum billed length is ten seconds.
- Output: preview model `canopylabs/orpheus-v1-english`, $22 per million characters, through `/openai/v1/audio/speech`. Voices are `autumn`, `diana`, `hannah`, `austin`, `daniel`, `troy`; default is Troy. WAV is the supported output format and input is limited to 200 characters per request. Only Aria's short spoken clause is sent, with no chat history. The current Arabic model also exists but is not implemented in this English voice UI.
- Groq always retains usage metadata. Inference content is not retained by default, but reliability/abuse logs may retain input/output for up to thirty days or longer when legally required. All customers may enable Zero Data Retention in Data Controls. The documentation places retained customer data in US GCP storage. Settings disclose that recordings/short spoken text leave the computer and explain the retention controls.

Sources: [speech input](https://console.groq.com/docs/speech-to-text), [Orpheus API, voices and pricing](https://console.groq.com/docs/text-to-speech/orpheus), [preview model status](https://console.groq.com/docs/model/canopylabs/orpheus-v1-english), [data policy](https://console.groq.com/docs/your-data).

## Samples and verification

Open `D:/Projects/Ari-aria-voice-spike/samples-v2/index.html`. New Heart WAVs are `ready.wav`, `question.wav`, `fallback.wav`, `names.wav` and `unknown.wav`. They contain 3.35–6.39 seconds of finite, non-silent 24 kHz mono PCM. Measured peaks are 0.387–0.494 and RMS is 0.061–0.064 before WAV encoding. There are no native missing-word warnings. Audio quality and pronunciation were not judged by ear.

Static checks passed against the final functional source checkpoint: workspace typecheck, lint on every changed JS/TS file, 7 contracts tests, 50 engine tests, 449 tests across 36 affected desktop suites, 3 native-diagnostic tests, and the desktop production build. Total: **509 tests passed**. The test coverage includes authored/fallback text, structured replies, normalization and dictionary coverage, interruption/replacement, disabling Aria, provider switching, missing credentials, HTTP errors and local fallback. Full commands and exit codes are in `aria-voice-measurements/verification.json`; full author logs remain in `aria-voice-checks/`.

The exact repeatable commands, each run through the shared lease, are:

```powershell
node D:/Projects/Ari-machines/scripts/coordination/run-heavy.mjs "Aria voice" "D:/Projects/Ari-aria-voice" -- node scripts/aria-voice-checks.mjs
node D:/Projects/Ari-machines/scripts/coordination/run-heavy.mjs "Aria voice" "D:/Projects/Ari-aria-voice" -- node scripts/aria-voice-measure.mjs 4 cpu
node D:/Projects/Ari-machines/scripts/coordination/run-heavy.mjs "Aria voice" "D:/Projects/Ari-aria-voice" -- node scripts/aria-voice-measure.mjs 2 cpu
node D:/Projects/Ari-machines/scripts/coordination/run-heavy.mjs "Aria voice" "D:/Projects/Ari-aria-voice" -- node scripts/aria-voice-measure.mjs 1 dml
$env:ELECTRON_RUN_AS_NODE = $null
node D:/Projects/Ari-machines/scripts/coordination/run-heavy.mjs "Aria voice" "D:/Projects/Ari-aria-voice" -- D:/Projects/Ari-aria-voice/apps/desktop/node_modules/electron/dist/electron.exe D:/Projects/Ari-aria-voice/scripts/aria-voice-utility-smoke.mjs
```


The isolated Electron utility smoke was repeated successfully on 2026-11-12 at source `86d1cc3e` with Electron 43.4.1. Under the shared lease and below-normal priority, four-thread CPU synthesis returned valid 24 kHz PCM; warmed first audio took **0.886 s**, initial preload/benchmark took **7.92 s**, and peak utility working set was **742 MiB**. Stale-generation cancellation, cancellation during synthesis, dictionary coverage and unknown-word spell-out all passed. `utility-smoke.json` records the complete receipt. This run changed only documentation/evidence, so the previously passing source checks remain applicable.

## Files and merge boundaries

The complete branch diff is available with `git diff feat/aria-experiment...feat/aria-voice`. Main groups are:

- `packages/contracts/src/aria-voice.ts`, its tests, RPC/settings contracts and the contracts export; `packages/engine/src/settings.ts` and `control-preamble.ts`; the bundled `apps/desktop/resources/cli/ari/SKILL.md`.
- `apps/desktop/src/main/speech/voice-{model,provider,worker,service,turn}.ts`, pronunciation, Groq client/key store and their regression tests; the existing speech service/download integration.
- Desktop main/Aria shortcut wiring and RPC registration; preload audio bridge; renderer playback hook, player, Read aloud, transcript/footer and session wiring; Experimental/AriaVoice/Speech settings and affected fixtures.
- Desktop dependencies/lockfile, Electron build entry and native packaging rules; four native/validation harnesses, diagnostics regression test and research evidence.

PR #514 overlaps the existing `SpeechSettings.tsx`, speech service, dictation shortcut/hold plumbing and speech settings fixtures/contracts. The TTS utility, pronunciation, provider client, playback and Aria voice settings remain separate files. This work stays based on PR #516's experiment branch and has not been integrated with either PR.

The user's remaining choices are to audition Heart/Michael and, optionally, paste a Groq key and choose input/output providers independently. Remaining verification limits are live Groq behavior/latency, full installed-app interaction and OS audio ducking, cross-platform native packaging/CoreML, compressed installer size and uninterrupted sentence-level playback under arbitrary load. Those limits do not require an account or paid call to finish this isolated implementation handoff.
