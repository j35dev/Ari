# Local dictation formatting

This change starts from local `main` / `origin/main` at `6f018a75` (v0.3.13).
The session's inherited `20409cba` snapshot is retained on
`ari/dictation-inherited-baseline-50ee3a3f`. Only the isolated session branch was
rebased. The main checkout and its existing changes were not modified.

## Pipeline and scope

Aria hold-to-talk and the general dictation shortcut use the widget's
`RecordingFlow`. The session composer microphone uses `SpeechButton`. Both
record with the existing microphone/AudioWorklet path, stop capture before
inference, and call `speech.transcribe`.

`SpeechService` validates the recording and uses the existing local GGUF model
in an Electron utility process. `transcribe-cpp` already supplies family
post-processing, optional native punctuation/capitalization, detected language,
and word timing metadata. Ari previously returned only its finalized `text`
without further formatting. The application uses batch transcription; it does
not insert tentative streaming hypotheses.

Formatting now runs once in `SpeechService`, after successful native inference.
Aria sends that result through its existing handoff. General dictation and
composer microphones insert it at the captured target and selection. No mobile
speech-input implementation was found; desktop speech paths are the scope here.

## Behavior

- **Format dictated text** defaults to on. It enables the selected model's native
  punctuation when that model advertises support, then applies local spacing,
  conservative sentence casing/boundaries, clear ordinal lists and paragraph
  breaks. A reliably aligned pause of at least 1.8 seconds after existing sentence
  punctuation can create a paragraph. A clear topic transition can also create
  one. Disabling formatting returns the provider's normal finalized text; native
  family defaults remain intact.
- **Spoken formatting commands** defaults to off. Enabling it interprets English
  `new paragraph`, `new line`, `bullet point`, `numbered list`, `next item`,
  `end list`, `full stop`, `question mark`, `exclamation mark`, `comma`, `colon`
  and `semicolon`. `literal` before a command keeps its words. Quoted phrases and
  code remain literal. Leading/trailing paragraph commands survive repeated
  dictation; a standalone paragraph command inserts a paragraph into a draft.
- Text remains data. There is no instruction-following formatter, summarization,
  rewriting, translation, filler removal, generated facts, or added AI endpoint.
  Code, quoted strings, identifiers, model IDs, paths and URLs are protected from
  casing and formatting inside their spans. Unknown word casing is left alone.
- The existing captured-draft, selection, focus, session, generation and capture
  lease guards remain. Adjacent utterances get a space when appropriate; CJK,
  Thai and other supported scripts without word spaces do not get artificial
  join spaces. Paragraphs and lists remain multiline, and the caret moves past
  the inserted text. Silence creates no insertion.
- If formatting throws or unexpectedly produces empty text, the native
  transcript is retained. If a current transcript cannot be inserted into the
  composer, the draft is left alone and the full text is kept in a selectable
  recovery view. A failed global insertion/handoff offers a native review dialog
  with explicit Copy/Dismiss actions. Clipboard contents are replaced only if
  Copy is selected. Cancelled/stale attempts do not auto-retry or paste elsewhere.

This adds no paid service, credential, cloud upload or model download. It leaves
audio capture, transcription task/ITN defaults, audio ducking, provider selection
and native key handling intact.

## Before and after

These are the actual formatter outputs asserted by regression tests, rather than
claims about recognition accuracy. The first two also appear in the real
Electron composer evidence.

**Rambling request**

Before:

```text
okay so i checked the build and it works now i want to review the errors can you help me with that
```

After:

```text
Okay, so I checked the build and it works. Now I want to review the errors. Can you help me with that?
```

**Clear list, after another dictated paragraph** (spoken commands enabled)

Before:

```text
new paragraph i need three things first run the tests second check the logs third update the README
```

After, with a paragraph break before the text:

```text
I need three things:
1. Run the tests.
2. Check the logs.
3. Update the README.
```

**Technical names and a question**

Before:

```text
can you keep useSpeech and gpt-6-astra in D:\Projects\Ari\src\App.tsx exactly as written
```

After:

```text
Can you keep useSpeech and gpt-6-astra in D:\Projects\Ari\src\App.tsx exactly as written?
```

**Explicit structure** (spoken commands enabled)

Before:

```text
my tasks colon bullet point check the logs bullet point run the tests end list thanks for helping
```

After:

```text
My tasks:
- Check the logs.
- Run the tests.

Thanks for helping.
```

**Multilingual preservation**

`bonjour. je veux garder Ari et useSpeech.` becomes
`Bonjour. Je veux garder Ari et useSpeech.`

`我们先检查 API。然后保留 gpt-6-astra。` remains unchanged.

## Verification

Passed on Windows with Electron 43.4.1: **612 desktop tests in 37 focused suites**,
**57 contract tests**, workspace type checks (and a final desktop type check),
lint on affected files, the desktop production build, and the hidden real
Electron composer check below. The screenshot was visually inspected; the
persisted draft and cursor matched the displayed result, with the cursor at
character 183 after the two recordings.

Regression coverage includes rambling speech and word preservation, direct and
indirect questions, ordinal prose versus lists, paragraphs and reliable/invalid
pause metadata, technical names, code/quoted content, instruction-like content,
French/Spanish/Russian/Chinese/Arabic/mixed speech, explicit/literal commands,
leading/trailing and standalone breaks, disabled formatting and failure fallback.

Integration coverage exercises native support probing and default fallback,
native language/word metadata, persisted settings migration, the actual controlled
composer, draft persistence, selection replacement, repeated insertion and caret
position, manual edits and transcript recovery, cancellation, stale results,
silence, leases, widget handoff and native insertion without retries.

The hidden Electron fixture uses synthetic microphone audio and mocked finalized
ASR text with the real recorder, composer, preload/IPC and text target. It checks
two recordings, saved draft contents, cursor position, and the rendered result.
It uses a fresh profile per run and never installs a global hook, opens a visible
window, uses the real microphone, or downloads a model.

Generated review artifacts, retained in this worktree:

- `apps/desktop/out/dictation-formatting-evidence/composer.png`
- `apps/desktop/out/dictation-formatting-evidence/result.json`

To reproduce in a development installation, from `apps/desktop`:

```powershell
pnpm build
pnpm exec vite build --config dictation-fixture.config.ts
pnpm exec vite build --ssr src/main/speech/formatting.e2e.ts --outDir out/formatting-e2e --emptyOutDir
pnpm exec electron out/formatting-e2e/formatting.e2e.js
```

## Limits

Native recognition accuracy and model-specific punctuation remain the starting
point. The text fallback deliberately avoids guessing arbitrary grammar, proper
noun casing, or missing sentence/paragraph boundaries. English has the richest
text-only rules; other languages retain native punctuation and receive safe
casing/spacing and reliable pause breaks. Spoken commands and automatic ordinal
list recognition are English-only. Literal paths/URLs/code at a sentence's end
can retain their original ending to avoid attaching punctuation to a literal.

The Electron run verifies synthetic capture and UI behavior, not real speech
recognition or Windows UI Automation/SendInput against another app. Existing
platform and external-field limits remain. An external app can partially accept
native input before reporting an error; recovery offers the transcript for
manual review and never retries automatically. Kept composer text lasts for the
current composer instance; switching sessions/unmounting still cancels that
instance as before. The unrelated full repository test suite was not run.

## Prepared PR

Title: **fix(speech): format finalized dictation locally and preserve draft text**

Body:

Dictation currently produces an unstructured block and can glue repeated
utterances together. Format finalized speech once in the existing local speech
service, using the selected model's supported punctuation and language/timing
metadata plus a conservative text fallback. Ordinary prose stays prose, clear
ordinal lists become numbered items, technical literals stay intact, and spoken
formatting commands are opt-in.

Keep captured drafts/selections protected, insert natural separators and
preserve paragraph commands across recordings. If insertion is rejected, retain
the transcript for explicit recovery instead of silently losing it. No new
service, credentials, cloud upload or model download is required.

Validation: focused speech/composer/widget/settings regressions, workspace type
checks, lint on affected files, desktop production build, and a hidden real
Electron synthetic-audio composer check with screenshot and saved-draft/caret
assertions. Real ASR and external Windows editor behavior were not re-tested.

This is a local review draft. No PR was created and nothing was pushed.
