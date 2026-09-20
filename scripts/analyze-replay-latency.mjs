/** Downstream analysis only. References NEVER enter the controller or matcher.
 * Usage: node scripts/analyze-replay-latency.mjs baseline/evaluation.json after/evaluation.json
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

const paths = process.argv.slice(2);
if (paths.length !== 2) throw new Error("Provide baseline and after evaluation.json paths");
const [before, after] = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
const percentile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * q;
  return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1);
};
const analyze = (report) => report.cues.map((cue, index) => {
  const deliveries = report.state.deliveries;
  const end = report.cues[index + 1]?.referenceStartMs ?? Infinity;
  // Silver references are rounded to milliseconds; this is attribution in a
  // report, not a trigger gate. Shared raw ASR spans may contain multiple cues.
  const words = deliveries.filter((d) => d.evidence && d.evidence.wordStartMs >= cue.referenceStartMs - 0.5 && d.evidence.wordStartMs < end - 0.5);
  const consumed = words.filter((d) => cue.actualTriggerMs !== null && d.atMs <= cue.actualTriggerMs);
  const deciding = deliveries.find((d) => d.atMs === cue.actualTriggerMs && d.matcherTrace?.some((t) => t.event === "trigger" && t.candidateCue === cue.cueId));
  const progression = deliveries.filter((d) => d.expectedCueId === cue.cueId).map((d) => ({
    atMs: d.atMs, dueAtMs: d.dueAtMs, word: d.evidence?.wordText, cumulativeTranscript: d.evidence?.text,
    candidateCue: d.expectedCueId, eligibleRunnerUp: null, decision: d.decision,
    attempts: d.matcherTrace?.filter((t) => t.event === "matcher").map((t) => ({
      candidate: t.candidateCue, score: t.match?.score, reason: t.decision, anchor: t.match?.selectedAnchor,
      ambiguityCompetitor: t.match?.competitor ?? null, range: t.match ? [t.match.start, t.match.end] : null,
    })) ?? [],
  }));
  return {
    cueId: cue.cueId, referenceStartMs: cue.referenceStartMs, actualTriggerMs: cue.actualTriggerMs, timingErrorMs: cue.timingErrorMs,
    firstSpeechEvidenceMs: words[0]?.evidence?.wordStartMs ?? null,
    firstSpeechEvidenceDeliveredMs: words[0]?.atMs ?? null,
    firstSavedSpanOnsetMs: words[0]?.evidence?.onsetMs ?? null,
    firstWordEvidenceMs: words[0]?.dueAtMs ?? null,
    firstWordLowerBoundMs: words[0] ? words[0].dueAtMs - cue.referenceStartMs : null,
    consumedWordCount: consumed.length,
    consumedSpeechDurationMs: consumed.length ? consumed.at(-1).dueAtMs - consumed[0].evidence.wordStartMs : null,
    decidingEvidence: deciding?.evidence ?? null,
    decidingMatch: deciding?.matcherTrace?.findLast((t) => t.event === "matcher") ?? null,
    // Include even trailing/post-trigger additions, not just attempts while next.
    wordAdditions: words.map((d) => ({ word: d.evidence.wordText, startMs: d.evidence.wordStartMs,
      dueAtMs: d.dueAtMs, deliveredAtMs: d.atMs, cumulativeTranscript: d.evidence.text })),
    progression,
  };
});
const baseline = analyze(before), improved = analyze(after);
const lowerBounds = baseline.map((cue) => cue.firstWordLowerBoundMs).filter((n) => n !== null);
const result = {
  version: 1, inputPaths: paths.map((path) => resolve(path)),
  interpretation: "Saved completed-word evidence only; first speech is saved word start (not measured VAD). Reference-based cue attribution is downstream and silver, never runtime authority. Runner-up is null because only next cue is selectable; ambiguity competitors are separately labelled. Consumed counts include ASR-mismatched opening words in the cue's reference window, not previous cue tails. Lower bound optimistically assumes first word alone identifies the cue; NOT an alternative scheduler or measured live latency.",
  metrics: { before: before.metrics, after: after.metrics,
    averageWordsBefore: baseline.reduce((sum, cue) => sum + cue.consumedWordCount, 0) / baseline.length,
    averageWordsAfter: improved.reduce((sum, cue) => sum + cue.consumedWordCount, 0) / improved.length,
    optimisticFirstWordLowerBound: { medianMs: percentile(lowerBounds, 0.5), p95Ms: percentile(lowerBounds, 0.95) },
  }, baseline, improved,
};
const output = resolve(".stage-data/replay-evaluations", `latency-${randomUUID()}`);
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "progression.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ output, ...result.metrics }, null, 2));
console.table(baseline.map((cue, index) => ({ cue: cue.cueId, beforeMs: cue.timingErrorMs, afterMs: improved[index].timingErrorMs,
  firstWordBound: cue.firstWordLowerBoundMs, wordsBefore: cue.consumedWordCount, wordsAfter: improved[index].consumedWordCount,
  decidingWord: improved[index].decidingEvidence?.wordText, anchor: improved[index].decidingMatch?.match?.selectedAnchor })));
