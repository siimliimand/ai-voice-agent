# Test fixtures

Files here are consumed by the dev-page replay mode (`GET /dev/fixtures` and
`GET /dev/fixtures/:name` in `src/web/dev-call/routes.ts`) and by the STT
bake-off (`npm run bakeoff`).

## Contents

| File              | Purpose                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `fixture-et.wav`  | Synthetic Estonian-style placeholder recording (~110 Hz f0)      |
| `fixture-ru.wav`  | Synthetic Russian-style placeholder recording (~130 Hz f0)       |
| `fixture-en.wav`  | Synthetic English-style placeholder recording (~150 Hz f0)       |
| `fixture-*.txt`   | Reference transcripts the bake-off scores STT output against     |

Regenerate the wavs with `npm run fixtures`. Output is deterministic (seeded
PRNG), so regeneration is byte-stable.

## IMPORTANT: these wavs are synthetic placeholders

- The `.wav` files are **SYNTHETIC structural placeholders**, not real speech.
  They are generated tones shaped to be speech-like (voiced f0 in the human
  range, 3-6 Hz syllable-rate envelope, harmonics, pauses between words) so
  the replay pipeline, dev page and e2e tests have realistic audio to move
  through the WebSocket transport at 16 kHz PCM16.
- They are **NOT suitable for evaluating STT accuracy**. No STT provider will
  transcribe them into the reference transcripts.

## Before running the STT bake-off

Before using the bake-off for provider selection, replace the wavs with **real
call recordings in Estonian, Russian and English** (including et-ru
code-switching samples), **keeping the same filenames** (`fixture-et.wav`,
`fixture-ru.wav`, `fixture-en.wav`). Requirements:

- 16 kHz, mono, 16-bit PCM WAV (same as Twilio Media Streams audio).
- One support-line utterance per file, ~5 s, matching the language of the
  corresponding `.txt` file.
- Add extra files (e.g. `fixture-et-ru.wav`) only if you also update the
  bake-off fixture list; the three names above are wired into the replay list
  automatically (any `*.wav` in this directory is served).

## Reference transcripts

The `.txt` files hold the reference transcripts the bake-off scores against
(word error rate / WER). Keep them in sync with what is actually said in the
replacement recordings - if you swap in real audio whose wording differs,
update the matching `.txt` file to the exact expected text.
