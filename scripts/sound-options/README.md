# Ari sound audition — Sound.1

Exploration only: no renderer, notification setting, or production default changes.

From the worktree root:

```sh
node scripts/sound-options.mjs
node --test scripts/sound-options.test.mjs
python -m http.server 4318 --bind 127.0.0.1 --directory .ari/sound-options
```

Open <http://127.0.0.1:4318> or double-click `.ari/sound-options/index.html`.
The output is local-only, self-contained, and works without a network connection.
Select Completion / Needs you / Error, play individual cues, A/B current → candidate,
listen to all six, repeat the last choice five times, or download WAVs. Escape stops playback.

| Family | Direction | Recommendation |
| --- | --- | --- |
| Soft Glass | Rounded mallet lift with restrained glass harmonics | First choice for a polished Ari default |
| Warm Felt | Dampened, low-register keys | First choice for busy multi-agent sessions |
| Quiet Relay | Short pitched knocks with filtered deterministic noise | A tactile, less musical alternative |
| Orbit | Soft-attack, lightly detuned chord bloom | More atmospheric; more audible presence |
| Droplet | Smooth pitch-drop pops | Friendlier, deliberately more playful |

The current reference reconstructs `features/moment/settle-sound.ts` frequencies,
timing, and gain envelopes. Audition clips are active-RMS matched to 0.045 with a
0.24 peak ceiling, not perceptually loudness-calibrated. Original-gain references
are also available; master volume defaults to 55%. WAVs are mono PCM16 at 48 kHz.
All new sounds are original procedural synthesis, with no external sound assets or
new dependencies. UI tokens and OFL-licensed fonts are copied from Ari's existing
UI package, with font licenses. Pick a family before considering integration.
