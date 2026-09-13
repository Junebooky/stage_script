# Local performance implementation plan

Source: `implemention_plan.md` (all 33 sections) and `ref_new.tsx`.

## Baseline audit

The repository already separates canonical JSON, normalization/matching, the ordered cue engine, recognition evidence cursor, React rendering, Web Audio capture and the optional Python socket. The 16-cue demo, two-syllable interim path, waveform, prepared captions, cue queue and manual controls are working. Missing boundaries are hierarchical show authoring, act safety, calibrated profiles/fallback, rehearsal analysis/storage, an authoritative external output and real optional local ASR. The current backend is explicitly a mock. Browser recognition is not an offline performance provider.

## Incremental sequence

1. Extend schema without breaking legacy SOLO scripts; add profiles, interpretable internal/fuzzy matching, UNMATCHED SPEECH, guarded fallback and manual evidence checkpoints. Preserve the aggressive demo policy separately from conservative performance policy.
2. Add generic act lifecycle with explicit completion/intermission/ARM/GO, locked cues outside LIVE, readiness and boundary timing reset.
3. Add `/operator` and read-only `/output`, local authoritative snapshots, caption/image/black output, local assets and HDMI extended-display workflow.
4. Add raw-audio ingestion, local decode/ASR boundary, whole-show broad alignment, local cue observations, review queue and relative timing/profile extraction. Keep observations and source captions distinct.
5. Replay historical rehearsals for champion/challenger evaluation; require explicit operator promotion. Expose local-ASR-unavailable honestly; optional concrete provider never downloads models at runtime or in CI.
6. Replace the gyroid with the supplied membrane point field, preserve audio/caption UI, and verify unit, backend, browser, typecheck and production build commands.

## Verification and release boundary

No synthetic recognition timing is an acoustic benchmark. Machine alignment is pseudo-ground-truth until reviewed. A locally installed model and human-confirmed rehearsal/venue evaluation are prerequisites for real-show approval. Each completed area and remaining limitation will be reported against the requested acceptance criteria.

## Implemented and verified

The six increments above are now implemented: separate demo/performance policy, act runtime, authoritative local audience output, original-audio rehearsal jobs and alignment, gated profile evaluation/promotion, optional actual local model provider, and the reference membrane visual. Unit, backend, browser, typecheck and production build verification ran successfully. Actual acoustic-model integration remains skipped without a supplied local model/recording.

See [implementation-report.md](implementation-report.md) for all 16 requested reporting items, exact test results, partial implementation boundaries and the remaining real-show approval checklist. This status does not claim production readiness.
