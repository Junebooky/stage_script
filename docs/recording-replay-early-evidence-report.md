# R001 / M05-2: completed-word early evidence

Base: `dba9c960a163529f1c00cb2d17d8a27c44c18d3f`. Worktree was clean before this change. Scope is saved recording replay, not live microphone recognition. The original implementation handoff did not commit or push; the subsequent user-authorized freeze validation is recorded below. No deployment, provider request, model installation, canonical edit, reference edit, or UI redesign was performed.

## 1. Measured cause and implementation order

First reproduced the **unmodified actual-WAV browser full-run**: 27/27 rendered in canonical order, median **3146.229 ms**, P95 **3968.954 ms**, maximum evidence dispatch lag **35.831 ms**. Then added instrumentation without changing matcher decisions; the instrumented baseline reproduced the existing deterministic timings exactly (median 3120.250 ms / P95 3934.000 ms). Only after inspecting all 27 progressions was the early path added.

The baseline was **not waiting for complete sentences or final ASR results**. It needed on average 2.222 saved words. Its local performance policy normally required at least four normalized characters, even when a shorter completed word already distinguished the next cue. It also required stronger internal evidence when the opening was misrecognized. A separate limitation is that saved evidence becomes available only at word end. Browser delivery/painting is not the main bottleneck.

Examples from the actual saved evidence:

- C001 starts at 8420 ms. `창가로` is delivered at 9600 ms, but has only three normalized characters: score 0, `below-four-character-baseline`. Baseline waits until `스며드는` ends at 11760 ms. The new exact unique-word path accepts `창가로` at 9600 ms, removing 2160 ms of extra waiting.
- C008 starts at 61620 ms. The observed opening is `더러워요`, not the authored opening. Neither path treats that as a safe short match. `내` ends at 65100 ms; `내 품이` is available at 66020 ms. Baseline still waits for `매일` at 67000 ms because the internal phrase has only three characters. New two-word internal evidence accepts `내 품이` at 66020 ms. The remaining 4400 ms is real evidence delay/recognition ambiguity, not polling.
- C024 already triggered on its first word in the baseline. That word ends 2300 ms after the reference start, so this matcher change cannot advance it.

## 2. Minimal policy change

`DiscriminativeWordMatcher` wraps the existing `PrefixFuzzyMatcher`. Baseline thresholds and fuzzy recovery remain unchanged. Only the recording controller opts in; the default engine and live operating path remain unchanged.

The extra path requires all of:

1. `PERFORMANCE_LOCAL`, `NORMAL`, candidate offset 0, active speech, a non-image cue, and an explicit saved-completed-word provenance flag.
2. Unconsumed **whole observed words**, mapped through the original transcript's punctuation/filler normalization and the engine's normalized cursor offset. No invented partial word, future text, or altered evidence time.
3. An exact canonical prefix of at least two characters, or an internal phrase of two complete observed words / at least three characters starting at an authored word boundary. Common short pronouns/deictics do not identify a cue alone. Authored tiny cues retain the baseline native-confidence requirement.
4. At least a one-third normalized edit-similarity margin against every fragment in the engine's existing nearby window (three cues before and after). A shared opening is rejected. Competitors are diagnostic negative examples, **not selectable runner-ups**.
5. Existing engine cursor, previous-line exclusion, manual checkpoints, hold, next-only search, and lifecycle authority remain in control.

The runtime enumerates one-word before two-word evidence; it does not contain recording IDs, cue IDs, cue-specific timing, transcription corrections, or reference-derived dispatch rules. A score of 1 means an exact text match, **not measured acoustic confidence**. Saved confidence stays unavailable. Distant identical phrases are distinguished by the ordered occurrence pointer, not by pretending their words are acoustically unique.

## 3. Per-cue timing and deciding evidence

Times below are seconds on the original recording's media timeline, rounded to 1 ms. These are deterministic word-end deliveries, isolating the matcher from browser jitter. All IDs retain the `M05-2_` prefix. The complete browser measurements and every evidence addition are in the private artifacts listed below.

“Words” counts all saved words heard in that cue's downstream reference-attributed window through the trigger, including a misrecognized opening. It does not count trailing words from the previous cue. Thus C008 uses a two-word matching phrase but has consumed three words including the incorrect opening. “Speech duration” in the JSON is the word-start-to-last-end envelope, not a measured voiced-only duration.

| Cue | Reference start | Before trigger | After trigger | Delay before → after | Deciding normalized evidence | Words before → after |
|---|---:|---:|---:|---:|---|---:|
| C001 | 8.420 | 11.760 | 9.600 | 3.340 → 1.180 | 창가로 | 2 → 1 |
| C002 | 16.400 | 18.880 | 18.880 | 2.480 → 2.480 | 지금어딘가 | 2 → 2 |
| C003 | 24.000 | 27.940 | 25.940 | 3.940 → 1.940 | 내성을 | 3 → 2 |
| C004 | 32.420 | 34.880 | 33.160 | 2.460 → 0.740 | 어서 | 3 → 1 |
| C005 | 40.420 | 44.340 | 41.920 | 3.920 → 1.500 | 우리를 | 2 → 1 |
| C006 | 48.700 | 50.540 | 50.540 | 1.840 → 1.840 | 끔찍하게 | 1 → 1 |
| C007 | 56.060 | 59.660 | 57.880 | 3.600 → 1.820 | 이별은 | 2 → 1 |
| C008 | 61.620 | 67.000 | 66.020 | 5.380 → 4.400 | 내품이 | 4 → 3 |
| C018 | 78.800 | 81.640 | 80.000 | 2.840 → 1.200 | 창가로 | 2 → 1 |
| C019 | 85.040 | 88.080 | 88.080 | 3.040 → 3.040 | 지금어딘가 | 2 → 2 |
| C020 | 92.380 | 96.260 | 94.420 | 3.880 → 2.040 | 내성을 | 3 → 2 |
| C021 | 99.860 | 102.360 | 100.780 | 2.500 → 0.920 | 어서 | 3 → 1 |
| C022 | 108.880 | 111.060 | 110.360 | 2.180 → 1.480 | 저높은 | 3 → 2 |
| C023 | 115.229 | 118.349 | 117.329 | 3.120 → 2.100 | 어떻게 | 2 → 1 |
| C024 | 123.109 | 125.409 | 125.409 | 2.300 → 2.300 | 만나서는 | 1 → 1 |
| C025 | 130.409 | 132.109 | 131.109 | 1.700 → 0.700 | 이미 | 2 → 1 |
| C026 | 137.989 | 141.029 | 138.969 | 3.040 → 0.980 | 내게로 | 2 → 1 |
| C027 | 141.029 | 144.289 | 143.629 | 3.260 → 2.600 | 걱정 | 2 → 1 |
| C028 | 152.049 | 155.189 | 153.249 | 3.140 → 1.200 | 잠들지 | 2 → 1 |
| C029 | 155.189 | 159.029 | 158.009 | 3.840 → 2.820 | 동이 | 2 → 1 |
| C030 | 166.369 | 169.329 | 167.289 | 2.960 → 0.920 | 외로운 | 2 → 1 |
| C031 | 173.989 | 176.029 | 174.869 | 2.040 → 0.880 | 이밤을 | 3 → 2 |
| C032 | 179.209 | 181.769 | 181.029 | 2.560 → 1.820 | 아득한 | 2 → 1 |
| C033 | 190.369 | 193.569 | 191.649 | 3.200 → 1.280 | 어두운 | 2 → 1 |
| C034 | 195.529 | 199.109 | 199.109 | 3.580 → 3.580 | 길을열어주오 | 2 → 2 |
| C035 | 199.109 | 202.249 | 202.249 | 3.140 → 3.140 | 우리잠시 | 2 → 2 |
| C036 | 210.729 | 213.949 | 212.389 | 3.220 → 1.660 | 창가로 | 2 → 1 |

21 cues improve, six are unchanged, none gets slower at equal delivery times. 18/27 now trigger after one saved word. Mean consumed words: **2.222 → 1.370** (60 → 37 total).

| Deterministic metric | Baseline | Improved |
|---|---:|---:|
| Median absolute timing error | 3120.250 ms | 1820.000 ms |
| P95 absolute timing error | 3934.000 ms | 3448.250 ms |
| Late cues under unchanged 1500 ms rule | 27 | 15 |
| Correct performed cues | 27/27 | 27/27 |
| Wrong / missed / early | 0 / 0 / 0 | 0 / 0 / 0 |
| Unexpected skip / repeated confusion / post-take false trigger | 0 / 0 / 0 | 0 / 0 / 0 |
| Manual / fallback | 0 / 0 | 0 / 0 |
| Absent canonical cues | 9 | 9 |

## 4. Ambiguity and hardest cases

- **C008 is still hardest:** the incorrect first word is not safely recoverable as a short exact prefix. Accepting it would require a new error assumption, not just faster matching. It waits for `내 품이`; no cue-specific substitution was introduced.
- C002/C019 `지금` also occurs inside nearby C004/C021. Diagnostic competitor score 1 blocks the short word. They wait for `어딘가`.
- C034 `길을` also occurs in C032's trailing lyric. It remains blocked until stronger evidence, including across fresh raw ASR span boundaries. This preserves safety at the cost of the remaining 3580 ms delay.
- C035's `우리` is a weak standalone pronoun, so the added early path does not accept it alone. Existing stronger matching remains responsible for the later decision.
- C001–C004 versus C018–C021 keep distinct canonical IDs and correct occurrences; C036's shared opening also relies on the already-advanced pointer. Adjacent identical or near-identical lyrics are covered by explicit negative tests, including old-final/cumulative revisions. This is **not** a claim to acoustically identify arbitrary out-of-order distant repetitions or to tolerate an incorrectly initialized pointer.
- Short exact matching inherently has less redundancy than longer matching. Noise transcribed into the exact next unique word can still be indistinguishable from that word without acoustic/streaming evidence. One recording plus adversarial fixtures does not establish a production false-positive rate. We did not weaken fuzzy thresholds or expand the candidate window to hide that uncertainty.

## 5. Word-end lower bound and live-only limits

Delivery remains `word.endMs <= audio.currentTime * 1000`. Word starts are never used to reveal word text. Even an optimistic oracle that identified every cue from its first saved word would have median **1280.260 ms**, P95 **2510.259 ms**. In particular, the first words of C027 and C029 are unavailable until +2600.260 and +2820.250 ms; C024's first word ends at +2300.256 ms. The unchanged percentile calculation already puts P95 above 2 seconds before any matcher ambiguity is considered.

Therefore **P95 < 2000 ms is impossible under this completed-word evidence policy without leaking future text**. Median <1500 ms is not proven impossible: the optimistic bound is lower. The implemented conservative discrimination policy reaches 1820 ms; we do not claim the stretch median target was met. The 1/3 ambiguity margin and weak-word guard were not relaxed to force that number.

`firstSpeechEvidenceMs` in the analysis means the first saved word's source start, not a measured live VAD event. `firstSpeechEvidenceDeliveredMs` records when that evidence was actually delivered; `firstSavedSpanOnsetMs` identifies the raw ASR span, which may cover multiple cues. Reference-window attribution exists only in the downstream report. References remain silver/ASR-assisted with their existing warnings.

Actual streaming partial arrival, stability/revision behavior, endpointing latency, acoustic confidence, sustained sung-syllable identification before word end, and live false-positive rate can only be measured with real streaming evidence. No such data was invented, no live implementation was added, and the new fast path cannot activate without the saved-completed-word flag.

## 6. Instrumentation and reproduction

Each saved word delivery exports its raw word, cumulative transcript, source start/end, actual delivery clock, next candidate, and all matcher attempts. Attempts include total score, score components, anchor/range, ambiguity competitor, cursor floor, rejection/acceptance reason, and a monotonic trace sequence. The single eligible candidate means an eligible runner-up is genuinely null. A rejected exact anchor can have score 1 with competitor 1; its ambiguity rejection is explicit, not a threshold failure.

The downstream analysis joins references to both runs and records all 27 reference/trigger times, first evidence, every word addition including post-trigger tails, consumed count/duration, and deciding evidence. It cannot call the controller or alter dispatch. Raw artifacts stay under ignored `.stage-data`.

```sh
npm run rehearsal:replay-check -- --policy baseline
npm run rehearsal:replay-check -- --policy discriminative-words
node scripts/analyze-replay-latency.mjs BASELINE/evaluation.json IMPROVED/evaluation.json
npm test
npm run typecheck
npm run test:backend
npm run test:e2e
npm run rehearsal:verify-browser
```

Private local assets and the existing local servers are required for the real-WAV browser command. The browser verifier blocks all non-loopback requests and all non-GET requests.

## 7. Tests, browser verification, and provenance

- Unit/regression: **192 passed**, including 27 new tests and the optional private real-ASR comparison (ran, not skipped).
- TypeScript: passed.
- Backend: **78 passed, 1 skipped** (existing optional local model test); two existing dependency deprecation warnings.
- Browser E2E: **32 passed**. These include synthetic fixtures; their timing is not claimed as real ASR latency.
- Actual-WAV improved browser full-run: **226.476 seconds elapsed**, media duration **226.138479 seconds**, playback rate 1×, ended normally, all **129 words / 24 raw segments** consumed. Audience DOM observations confirm **27 canonical captions in exact order**, with each rendered caption's text checked against canonical. Browser errors: **0**.

The browser-verification workflow checked the whole audio → saved evidence → engine → audience chain, not merely trigger logs. Operator and audience completion screenshots were also visually inspected. Pause froze the audio/evidence state, resume advanced it, stop blacked the output, and restart reset the replay. The operator was backgrounded during seconds 25–85 without losing cue delivery.

| Actual browser metric | Baseline | Improved |
|---|---:|---:|
| Median absolute timing error | 3146.229 ms | 1826.523 ms (**41.9% lower**) |
| P95 absolute timing error | 3968.954 ms | 3472.675 ms (**12.5% lower**) |
| C008 delay | 5395.002 ms | 4427.174 ms |
| Correct / rendered | 27 / 27 | 27 / 27 |
| Wrong / missed / early | 0 / 0 / 0 | 0 / 0 / 0 |
| Unexpected skip / repeat confusion / post-take false trigger | 0 / 0 / 0 | 0 / 0 / 0 |
| Manual / fallback / coalesced triggers | 0 / 0 / 0 | 0 / 0 / 0 |
| Late cues under unchanged 1500 ms rule | 27 | 16 |
| Maximum evidence delivery lag | 35.831 ms | 38.733 ms |

The improved browser's 16 late cues versus deterministic 15 comes from C005's exact +1500 ms becoming +1506.8 ms after dispatch. The tolerance was **not** changed to hide this. C024/C035 have slightly later browser times from ordinary dispatch jitter despite unchanged word-end trigger decisions.

### Actual browser per-cue observations (milliseconds)

| Cue | Baseline trigger | Improved trigger | Delay baseline → improved |
|---|---:|---:|---:|
| C001 | 11774.7 | 9606.6 | 3354.7 → 1186.6 |
| C002 | 18895.5 | 18887.1 | 2495.5 → 2487.1 |
| C003 | 27974.9 | 25967.4 | 3974.9 → 1967.4 |
| C004 | 34894.9 | 33167.4 | 2474.9 → 747.4 |
| C005 | 44375.2 | 41926.8 | 3955.2 → 1506.8 |
| C006 | 50575.2 | 50567.2 | 1875.2 → 1867.2 |
| C007 | 59695.4 | 57886.5 | 3635.4 → 1826.5 |
| C008 | 67015.0 | 66047.2 | 5395.0 → 4427.2 |
| C018 | 81655.5 | 80007.8 | 2855.5 → 1207.8 |
| C019 | 88094.9 | 88086.6 | 3054.9 → 3046.6 |
| C020 | 96295.5 | 94447.4 | 3915.5 → 2067.4 |
| C021 | 102375.3 | 100806.8 | 2515.3 → 946.8 |
| C022 | 111095.3 | 110367.2 | 2215.3 → 1487.2 |
| C023 | 118375.2 | 117353.9 | 3146.2 → 2124.9 |
| C024 | 125415.8 | 125447.3 | 2306.8 → 2338.3 |
| C025 | 132134.8 | 131127.5 | 1725.8 → 718.5 |
| C026 | 141054.5 | 139007.1 | 3065.5 → 1018.1 |
| C027 | 144294.9 | 143648.0 | 3265.9 → 2619.0 |
| C028 | 155214.7 | 153287.2 | 3165.7 → 1238.2 |
| C029 | 159049.4 | 158047.1 | 3860.4 → 2858.1 |
| C030 | 169334.8 | 167293.3 | 2965.8 → 924.3 |
| C031 | 176049.6 | 174887.3 | 2060.6 → 898.3 |
| C032 | 181775.6 | 181047.2 | 2566.6 → 1838.2 |
| C033 | 193575.7 | 191687.2 | 3206.7 → 1318.2 |
| C034 | 199135.4 | 199127.8 | 3606.4 → 3598.8 |
| C035 | 202255.7 | 202287.4 | 3146.7 → 3178.4 |
| C036 | 213975.7 | 212406.7 | 3246.7 → 1677.7 |

Canonical 36 and projection 27 + absent 9, original captions/order, C008→C018 projection transition, POST_TAKE_SPEECH, source labels, audience lock/sequence/ACK, and pause/resume/stop/restart are preserved. No profile was learned/promoted, and fallback remains OFF.

SHA-256 verification after completion (all unchanged):

- Original WAV: `2b7ce5887f92a5527f4dca1564d00aa2c95eb834ca2e0d6d06189b4588cdb5e7`.
- Saved ASR: `df3d8128e169e87775653955c3f6405744964af40dbc04b70edbd614ba30d5cf`.
- Canonical: `823e4630702aa3c1be4b2b59fed7fd10507ae3c0a459dcf8bb098407bfe73e74`.
- Reference: `f04bfef88722b28614e2e9706d16ffea4f30a9c46765d9c79705b0c1dc647e07`.
- Recording profile: `1b7a12885e6879edfc594d5cf0691fb2303bfc5abcbf6b3e5c58db94a961fd17`.

## 8. Artifacts and changed files

Artifacts are relative to `.stage-data/replay-evaluations/`:

- Unmodified actual browser baseline: `browser-74e0d294-f470-4e15-9f3f-36612edb1ff2/{evaluation.json,browser-validation.json}`.
- Instrumented deterministic baseline: `check-beef7ea5-587b-40a4-9360-8cf1139544bd/evaluation.json`.
- Improved deterministic run: `check-90923a39-a76b-4c02-8857-31376297f17c/evaluation.json`.
- Full per-cue comparison / word additions / matcher progressions: `latency-b6cacbb3-d58a-4ace-aa78-157bf1f6ab92/progression.json`.
- Actual improved browser artifacts: `browser-74378d4e-f8a4-4d3d-bd74-983e0a67ab04/{evaluation.json,browser-validation.json,operator-complete.png,audience-complete.png,audience-repeated-opening.png}`.
- Improved browser evidence progression alongside the instrumented **deterministic** baseline: `latency-68587240-2522-4674-8ceb-18caabab8311/progression.json`. This cross-mode artifact is labelled by its input paths; use the actual-browser table above for like-for-like browser timing comparison.

Changed files:

- `packages/alignment/src/index.ts`: optional provenance/context/diagnostic types and baseline reasons; no baseline threshold change.
- `packages/alignment/src/discriminative-word-matcher.ts`: opt-in exact completed-word discrimination.
- `packages/alignment/src/discriminative-word-matcher.test.ts`: adversarial matcher tests.
- `packages/script-engine/src/index.ts`: raw word-boundary context and matcher-attempt telemetry; existing state machine/candidate authority retained.
- `packages/script-engine/src/early-evidence.test.ts`: cursor, repeat, manual, hold, and post-take regressions.
- `packages/rehearsal/src/realtime-replay.ts`: replay-only matcher selection and delivery traces; unchanged media-clock scheduling.
- `packages/rehearsal/src/recording-replay.test.ts`: private evidence before/after regression.
- `scripts/replay-recording.mjs`: explicit baseline/improved comparison policy.
- `scripts/analyze-replay-latency.mjs`: downstream analysis artifact.
- This report.

## 9. Verdict

**READY FOR NEXT STEP** — for this saved-evidence replay milestone: all minimum identity/safety conditions remain satisfied, actual browser median and P95 both improve, and the completed-word lower bound is explicitly demonstrated. This is not production/live-ASR approval and does not claim the stretch targets (median <1500 ms / P95 <2000 ms) were achieved.

The next limiting evidence question is **when a stable discriminative word/prefix actually becomes available in real streaming ASR before its saved word end**. That requires new measurement, not fabricated replay partials; implementing a live provider or microphone remains outside this change.

## 10. Freeze validation — 2026-09-20

Re-ran the requested checks before the user-authorized local commit:

- `npm run build`: passed, optimized production build and route generation succeeded.
- `npm test`: 192 passed / 16 files, including the private saved-evidence regression.
- `npm run typecheck`: passed.
- `npm run test:backend`: 78 passed, 1 existing optional-model test skipped; two dependency deprecation warnings.
- `npm run test:e2e`: 32 passed, 44.8 seconds. This suite includes synthetic ASR/media fixtures, not live ASR latency measurements.
- `git diff --check`: passed; `git status` reviewed for an explicit source/test/report allowlist.
- Browser skill smoke verification: rehearsal UI rendered, no browser errors observed, screenshot inspected. Temporary verification browser/server closed after the suite. Dev-generated route type paths were regenerated by the production build and excluded from the commit.

Direct review of the actual diff confirmed:

- The default `ScriptFollowingEngine` still constructs `PrefixFuzzyMatcher`; normal `PERFORMANCE_LOCAL` still has one eligible next candidate. Baseline score/quality thresholds, fallback prerequisites, cursor, and manual/hold authority were not weakened.
- The only non-test production construction of `DiscriminativeWordMatcher` is in `RealtimeReplayController`. That replay defaults to the opt-in policy, but requires saved evidence validation and supplies the explicit `saved-completed-words` flag. Live callers neither select this matcher nor supply that provenance flag. The flag is an internal adapter contract, not a cryptographic assertion that arbitrary caller text is safe.
- No recording/cue IDs, lyric-specific substitution tables, or reference timings exist in the early matcher. The short pronoun/deictic list is a generic linguistic guard. References enter downstream evaluation/analysis only, never the runtime trigger decision.
- Replay rejects embedded cue profiles, passes an empty profile list, and preserves unavailable acoustic confidence. Fallback remains OFF for this replay; pre-existing explicitly calibrated fallback support elsewhere is not removed or silently activated.
- The canonical file still has 36 cues and the unchanged recording profile partitions 27 performed / 9 absent. The WAV, saved ASR, canonical, reference, and profile hashes above were independently rechecked and remain identical.

No blocking finding was found within this saved-evidence scope. The actual-WAV browser latency figures in section 7 are from the prior completed full-run, not a newly measured live streaming session. This freeze did not add a provider, microphone path, streaming measurement implementation, or external upload. Audio files, raw ASR/evaluation artifacts, credentials, user reference files, build outputs, and screenshots are excluded from the commit. No push is authorized by this freeze request.
