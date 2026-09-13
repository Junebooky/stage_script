# M05-2 real-data milestone — work log

## Audit before implementation (2026-09-13)

Read `ref.md` in full, including the authoritative script and all 80 sections. Inspected the existing schema, matcher/cursor/engine, show lifecycle, microphone/worklet/browser/local ASR paths, backend rehearsal and replay sources, Operator/Audience/Rehearsal components, captions/queue/keyboard/latency, membrane visual, documentation and regression tests. Preserve the existing dirty worktree and deleted reference files.

Findings:

- Operator and Rehearsal still fall back to the synthetic 16-cue show. No production registry or M05-2 canonical file exists.
- Offline analysis always performs whole-show number alignment, even when the recording's number is known. Repeated lyrics are penalized without enough sequence context.
- Existing live matching is already conservative and interim-driven. Manual checkpoint/generation fences, ARM/GO, audience-only output and local-ASR readiness must remain intact.
- Calibration has historical replay and explicit promotion gates, but does not distinguish one-recording timing estimates from a distribution or expose distant repeated-anchor collisions.
- The specified WAV path is absent. The actual source is `recordings/decadence-gyeongseong/R001/M05-2/M5-2_외로운별 _0420.wav`. Keep it in place; register the actual path. Raw audio must be ignored by Git.
- Neither faster-whisper nor a configured complete local model is available. Do not download a model, invent transcript/timestamps/metrics, or report successful real ASR.
- Previous milestone results are historical, not verification of these changes. Rerun all checks.

## Implementation sequence

1. Add a validated, extensible registry and human-editable authoritative canonical cues; switch real workspaces to the registry default while preserving explicit custom imports and `/demo` isolation.
2. Add immutable WAV inspection and a reproducible number-scoped CLI. Run it on the actual WAV. Persist inspection and explicit unavailable status if local ASR cannot run.
3. Add number-local sequence-aware alignment, uncertainty/repetition diagnostics, candidate-only calibration evidence and baseline-versus-candidate replay reports. Keep whole-show alignment as a separate future utility.
4. Connect the number-scoped rehearsal UI and expose canonical/observation separation, sample counts, review state and honest baseline comparisons. Keep the membrane unchanged.
5. Add real-canonical deterministic regression tests (not acoustic evidence); rerun unit, backend, typecheck, build and end-to-end tests. Write the required 19-part report with the complete cue list and exact rerun command.

## Boundaries

Musical surtitles only. No automatic champion promotion, fabricated future numbers, or automatic IMAGE cue for the instrumental outro. One recording can only produce a candidate; absent real ASR produces no candidate at all. Offline file replay timing is not measured live recognition latency.

## Latest user override: defer local model provisioning

The user explicitly asked to reuse an existing model or research a high-performing external model, and continue the remaining work. This supersedes the earlier local-only implementation boundary, not the canonical/privacy/promotion safeguards. No local model was downloaded.

- Researched current primary documentation for Soniox, ElevenLabs, OpenAI and Deepgram. Selected Soniox stt-async-v5 for opt-in batch transcription with Korean token timing/confidence. No universal best-in-musical claim without actual recordings/ground truth.
- Added Soniox REST adapter, consent/key checks, bounded polling, immutable original checks, remote job/file cleanup audit, CLI/UI provider selection and separate cloud pseudo timestamp provenance.
- Reused existing BrowserSpeechASRAdapter for the default ONLINE PREVIEW so M05-2 can be tried without a local model/API key. It retains interim matching, canonical output, ARM/GO, authority and manual-generation fencing. Explicit LOCAL input remains offline and never automatically falls back.
- Asked whether the actual private WAV may be uploaded. No affirmative reply or API key is available. Actual external audio calls have NOT run. The no-consent CLI run correctly stopped with exit 2 after inspection only.
- Implemented all planned data/registry/known-number/candidate comparison/UI changes. Validation found and fixed a real macOS workspace-symlink path bug. Full results and the required 19-part report are in `m05-2-report.md`.
