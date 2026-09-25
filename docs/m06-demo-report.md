# M06 audio-track demonstration

## Usage

Start the local web app and `npm run dev:backend`. On `/operator`, choose **음원 시연 모드 → M06 → 재생 시작**. The registered original WAV plays through the browser's audio output; all 26 canonical captions follow its media clock without microphone input or manual GO. `/output` receives the same canonical cues. Pause, seek, stop and number switching remain supported.

Alternatively choose the original WAV with **음원 파일 선택**: local SHA-256 matching selects M06 automatically. The file is read in the browser, never uploaded. Unknown files retain the explicitly selected schedule and show an unverified warning; duration checks do not prove edit identity. Audio, credentials, private analysis artifacts and model files are not included in Git.

## Actual analysis (2026-09-25)

- Command: `npm run rehearsal:analyze -- --number M06 --provider groq --allow-cloud-upload`.
- One actual Groq request succeeded (HTTP 200), `whisper-large-v3`, Korean, temperature 0, verbose JSON, word + segment timestamps. Audio only, no canonical context, no fallback.
- Original: 39,219,744 bytes, 48 kHz stereo PCM WAV, 136,000 ms. Original not moved, renamed or edited.
- Original SHA-256 before/after: `a9c157e2b5e81702fb8683a17b7fa267462e70c18cb282f28f136d393a557866`.
- Temporary 16 kHz mono lossless FLAC: 4,939,398 bytes, under the 25 MB limit. Duration remained 136,000 ms; timeline offset and duration delta 0. No trimming/chunking/tempo changes. Temporary FLAC deleted.
- Transcription wall time: 2,970.568 ms; 15 segments / 109 words.
- CLI alignment: 26 aligned / 0 missed. Initial review-required cues: C011–C018, C024–C026 (11).
- Candidate profile generated locally, sampleCount 1, no champion promotion, fallback OFF.

## Timing quality and derivation

`R001-M06.reference.json` is an **ASR-assisted silver reference**, not human-confirmed onset ground truth. All 26 cue timings still need independent listening review before claiming precise musical alignment. This is presentation choreography, not streaming ASR or live latency.

Some raw provider words overlap or cross their segment bounds. The CLI's segment interpolation was therefore not used for demonstration timing. `buildWordDemoCues` aligns sequential canonical text directly against the 109 original timed words, preserving sung tokens such as “그/이”, raw overlaps and warnings. For example C011 starts at raw word time 59.880 s, not interpolated 52.200 s. Canonical captions and the live matcher normalizer/policy are unchanged. ASR text differences are not copied into captions.

## Artifacts

- Private run: `.stage-data/number-analysis/run-7627b2a5-7754-43d2-9572-744ee2438366/` (`external-asr.json`, `alignment.json`, `metrics.json`, `candidate-profile.json`, report).
- Versioned sanitized metadata: `data/replay-recordings/R001-M06.profile.json`, `R001-M06.reference.json`, registry.
- Canonical: `data/productions/decadence-gyeongseong/numbers/M06.json` (existing user-provided 26 cues preserved).
- Actual WAV remains in its existing `recordings/decadence-gyeongseong/R001/M05-2/` directory; registries reference that location deliberately.

## Reproducible checks

`npm test`, `npm run typecheck`, `npm run test:backend`, `npm run build`, `npm run test:e2e`.

For the separate real-media integration check (requires the private original and local backend):

```sh
M06_REAL_AUDIO=1 npx playwright test tests/e2e/m06-demonstration.spec.ts
```

The real-media check uses 1.0x playback, no microphone, no new ASR call, no seek/manual cue advancement. Scheduler error relative to the reference is not acoustic onset accuracy or live ASR latency.

## Verification results

- Unit tests: 224 passed. Backend: 80 passed, 1 environment-dependent test skipped. Typecheck, production build and diff whitespace checks passed.
- Standard browser suite: 36 passed; private real-audio test skipped by default, then run separately and passed.
- Actual original WAV: full 136 seconds at 1.0x, unmuted media element, 26/26 automatic cues in order, zero manual cues, final M06_C026 received by `/output`, no page errors. This verifies browser media playback, not physical speaker audibility.
- Final real-media run: media-clock scheduling delay relative to silver reference 4.845–27.914 ms. This does not validate the underlying ASR onset estimates.
- Synthetic seek checks verified all 26 `/output` captions against canonical text; number switching paused the old media and cleared output. Existing M05-2/microphone regression tests passed.
- Selecting the actual WAV locally automatically selected M06 by hash, displayed registered-original verification and used a browser-only blob URL.
- Original WAV hash remained unchanged after verification. Live PERFORMANCE_LOCAL policy, original M05-2 canonical/reference, and raw Groq evidence were not modified.
