/** Analyze only actual capture events. References are optional downstream audits,
 * never inputs to either shadow engine. Missing independent onset => null latency.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { createRunnableDevEnvironment, resolveConfig } from "vite";
const input = process.argv[2];
if (!input) throw new Error("Usage: node scripts/analyze-streaming-measurement.mjs capture.json");
const root = process.cwd(), output = dirname(resolve(input));
const capture = JSON.parse(await readFile(input, "utf8"));
if (capture.mode !== "actual-local-streaming-paced-file-not-microphone" || !capture.complete || !capture.sourceUnchanged) throw new Error("Incomplete/untrusted capture");
const compiler = createRunnableDevEnvironment("cli", await resolveConfig({ root, configFile: false, envDir: false,
  environments: { cli: { consumer: "server", resolve: { noExternal: [/^@stage\//] }, dev: { moduleRunnerTransform: true } } }
}, "serve"), { hot: false });
await compiler.init();
try {
  const { parseShow } = await compiler.runner.import(resolve(root, "packages/script-schema/src/index.ts"));
  const { buildRecordingReplayScript, evaluateRecordingReplay, percentile } = await compiler.runner.import(resolve(root, "packages/rehearsal/src/index.ts"));
  const { evaluateStreamingShadows } = await compiler.runner.import(resolve(root, "packages/rehearsal/src/streaming-shadow.ts"));
  const profile = JSON.parse(await readFile("data/replay-recordings/R001-M05-2.profile.json", "utf8"));
  if (capture.sourceSha256 !== profile.sourceAudioSha256) throw new Error("Wrong source WAV");
  const show = parseShow(JSON.parse(await readFile("data/productions/decadence-gyeongseong/numbers/M05-2.json", "utf8")));
  const script = buildRecordingReplayScript(show, profile);
  const result = evaluateStreamingShadows(script, capture.events);
  // Existing silver timing is allowed ONLY as a separately labelled identity audit.
  const silver = JSON.parse(await readFile("data/replay-recordings/R001-M05-2.reference.json", "utf8"));
  const identityAudit = (run) => {
    const audit = evaluateRecordingReplay(profile, silver, run.triggers.map((trigger) => ({ ...trigger, source: "automatic", evidenceDueAtMs: trigger.atMs, evidenceStartMs: null })));
    return { basis: "silver-reference-assisted provisional audit; NOT independently confirmed correct/wrong/early and NOT live latency",
      correct: audit.metrics.correctTriggerCount, wrong: audit.metrics.wrongTriggerCount, missed: audit.metrics.missedCueCount,
      repeatedLyricConfusion: audit.metrics.repeatedLyricConfusionCount, early: audit.metrics.earlyCount,
      cues: audit.cues.map(({ cueId, correctCue, missed, wrongCue, early }) => ({ cueId, correctCue, missed, wrongCue, early })) };
  };
  const stats = (values) => ({ median: percentile(values, .5), p95: percentile(values, .95), n: values.length });
  result.capture = { rtf: capture.rtf, inferenceMs: stats(capture.inferences.map((c) => c.wallMs)),
    sendLagMs: stats(capture.frames.map((f) => f.lagMs)), sourceSha256: capture.sourceSha256,
    sourceDurationMs: capture.originalDurationMs, versions: capture.versions };
  result.silverIdentityAudit = { immediate: identityAudit(result.immediate), stable: identityAudit(result.stable) };
  result.onsetLatency = { status: "NOT_MEASURABLE_WITHOUT_INDEPENDENT_AUDIO_ONSET_REVIEW", t1: null, t2: null, t3: null, t5: null,
    completedWordImprovement: null, reason: "No independently reviewed cue onset reference supplied. No live-ASR-derived or saved-Groq-derived t0 is substituted." };
  await writeFile(resolve(output, "shadow-analysis.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
  await writeFile(resolve(output, "onsets.review-template.json"), JSON.stringify({ version: 1, sourceSha256: capture.sourceSha256,
    status: "unreviewed", basis: "independent-audio-review-required", reviewer: null,
    cues: script.segments.map((cue) => ({ cueId: cue.id, onsetSample: null, endSample: null, firstDiscriminativeWordEndSample: null, note: "Use original 48000 Hz source; do not copy silver or live ASR timestamps" })) }, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ output, capture: result.capture, hypotheses: result.hypotheses, partials: result.partials, finals: result.finals,
    revisionRate: result.revisionRate, revisionNumerator: result.revisionNumerator, revisionDenominator: result.revisionDenominator,
    immediate: { emitted: result.immediate.emittedCount, anchorRemovalRate: result.immediate.anchorRemovalRate },
    stable: { emitted: result.stable.emittedCount, anchorRemovalRate: result.stable.anchorRemovalRate },
    silverIdentityAudit: result.silverIdentityAudit, onsetLatency: result.onsetLatency }, null, 2));
} finally { await compiler.close(); }
