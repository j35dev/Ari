# Aria voice feedback correction evidence

Runtime source: `276a2365e80ee2d6ac799e174dbf0d5f40a76b19`. Commits after this checkpoint record evidence/documentation only.

The user reported English punctuation failing, too little spoken detail, an unattractive error line, and ordinary words being read as letters. The changes normalize punctuation, retain fuller speech and useful Read aloud detail, preserve the direct question, render a padded dismissible notice, avoid inferring initials from capitalization, and fill common status-word dictionary gaps. APPROVED is present in the pinned dictionary; READY/DONE were affected by the previous all-capital expansion, while completed/reviewed/verified were genuine dictionary gaps.

Verification covers **86 distinct affected tests** in these selected suites: 10 contracts, 20 engine prompt and 56 desktop. Initial desktop coverage was 55; the later status-word regression adds one. Focused reruns (13/14 desktop tests) are not counted again. All ten workspace typechecks passed at `990a2982`; contracts types passed after `272dc041`, and desktop types/lint/build plus native utility passed at the runtime above.

Native Electron smoke: 0.843 s warmed first clause, 6.67 s preload, 3.972 s audio for the exact em-dash reply and 4.242 s for the status-word sentence. No native word skips or spell-out fallback for READY/APPROVED/completed/reviewed/verified/DONE. Stale and in-flight cancellation passed. These are generated-audio checks; audible quality/OS playback was not judged by ear.

Both [light](../../screenshots/aria-voice-feedback/voice-notice-light.png) and [dark](../../screenshots/aria-voice-feedback/voice-notice-dark.png) captures use actual VoiceNotice/Settings components. They assert styling, containment, dismissal and no console warnings/errors. They are synthetic component evidence with no live RPC/audio.

The initial static failures were test-only typing and an ESLint control-character assertion; `990a2982` corrected them. The initial Electron fixture timed out because readiness was awaited at the ESM entry boundary. The static-correction fixture then rejected Electron's missing-CSP warning. A later automatic capture passed containment but visual inspection exposed missing Tailwind utility compilation; that result is not accepted as visual evidence. The final fixture includes a CSP, the real Tailwind PostCSS pipeline, source registration and computed-style assertions. Historical failures and the insufficient capture remain recorded in their phase manifests; the final phase passes all seven steps.

Every heavy step used the shared lease, below-normal priority, D: temporary storage and one test worker without file parallelism. No live Groq request, installed Ari/profile change, Machines integration or Tailscale Serve change was made. Helper sources are archived as text for reproducibility; production startup code was not changed.
