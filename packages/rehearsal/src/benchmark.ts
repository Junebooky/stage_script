import { normalizeKorean } from "@stage/alignment";
import { flattenShow, type Show } from "@stage/script-schema";
import type { RehearsalAnalysis } from "./types";
import type { compareCandidate } from "./comparison";

export interface BatchObservationMetadata {
  provider: string;
  model?: string;
  audioSha256: string;
  transcriptionWallTimeMs: number;
}

/** Comparable acoustic input identity; machine coverage is NOT accuracy ground truth. */
export function buildASRBenchmark(show: Show, analysis: RehearsalAnalysis, observation: BatchObservationMetadata,
  inspection: Record<string, unknown>, comparison: ReturnType<typeof compareCandidate> | null) {
  const scope = new Set(show.acts.flatMap((act) => act.numbers.filter((number) => !analysis.numberId || number.id === analysis.numberId).flatMap((number) => number.cues.map((cue) => cue.id))));
  const cues = flattenShow(show).segments.filter((cue) => scope.has(cue.id));
  const words = analysis.transcript.flatMap((segment) => segment.words ?? []);
  const rows = cues.map((cue) => {
    const observations = analysis.observations.filter((item) => item.cueId === cue.id);
    const reviewed = analysis.reviewQueue.some((item) => item.cueId === cue.id);
    return { cueId: cue.id, section: cue.metadata?.section, delivery: cue.metadata?.delivery, ensemble: cue.metadata?.ensemble,
      status: !observations.length ? "missed" : reviewed ? "review-required" : observations.some((item) => item.reviewStatus === "warning") ? "warning" : "machine-aligned",
      observations: observations.map((item) => ({ startMs: item.startMs, endMs: item.endMs, score: item.alignmentConfidence,
        asrConfidence: item.asrConfidence ?? null, asrConfidenceBasis: item.asrConfidenceBasis ?? "legacy-unspecified",
        timingBasis: item.timingBasis, groundTruth: item.groundTruth, repetition: item.repetition })) };
  });
  const covered = rows.filter((row) => row.status !== "missed");
  const transitions = cues.slice(1).flatMap((cue, index) => {
    const previous = cues[index]!;
    if (cue.metadata?.section === previous.metadata?.section) return [];
    const left = analysis.observations.find((item) => item.cueId === previous.id);
    const right = analysis.observations.find((item) => item.cueId === cue.id);
    return [{ from: previous.id, to: cue.id, sections: `${previous.metadata?.section} → ${cue.metadata?.section}`,
      fromEndMs: left?.endMs ?? null, toStartMs: right?.startMs ?? null,
      status: !left || !right || left.reviewStatus === "review-required" || right.reviewStatus === "review-required" ? "review-required" : "machine-aligned-not-human-confirmed" }];
  });
  const internalRecoveries = analysis.observations.flatMap((item) => {
    const cue = cues.find((cue) => cue.id === item.cueId);
    const internal = item.anchors.filter((anchor) => cue?.matchText.some((text) => normalizeKorean(text).indexOf(anchor) > 0));
    return internal.length ? [{ cueId: item.cueId, anchors: internal, status: item.reviewStatus, interpretation: "internal text evidence; not acoustic proof of a missing first syllable" }] : [];
  });
  return {
    version: 1 as const, kind: "prerecorded-asr" as const, rehearsalId: analysis.rehearsalId,
    provider: observation.provider, model: observation.model ?? analysis.model ?? "unrecorded",
    audioSha256: observation.audioSha256, canonicalFingerprint: analysis.canonicalFingerprint, inspection,
    transcriptionWallTimeMs: observation.transcriptionWallTimeMs,
    liveLatency: { measured: false, p50Ms: null, p95Ms: null, p99Ms: null },
    segmentCount: analysis.transcript.length, wordCount: words.length,
    segmentsWithWordTimestamps: analysis.transcript.filter((span) => span.words?.length).length,
    wordConfidence: { native: words.filter((word) => word.confidenceBasis === "provider-native").length,
      derived: words.filter((word) => word.confidenceBasis === "segment-logprob-derived").length,
      unavailable: words.filter((word) => word.confidence === null).length },
    canonicalCueCount: cues.length, alignedCueCount: covered.length, observationCount: analysis.observations.length,
    canonicalCueCoverage: cues.length ? covered.length / cues.length : null,
    missedCueIds: rows.filter((row) => row.status === "missed").map((row) => row.cueId),
    reviewRequiredCueIds: rows.filter((row) => row.status === "review-required").map((row) => row.cueId),
    warningCueIds: rows.filter((row) => row.status === "warning").map((row) => row.cueId),
    reviewRequiredCount: analysis.reviewQueue.length,
    repeatedLyrics: rows.filter((row) => cues.find((cue) => cue.id === row.cueId)?.metadata?.repeatGroup),
    transitions, chorus: rows.filter((row) => row.ensemble === "chorus" || row.ensemble === "duet"),
    internalRecoveries, unmatchedRegions: analysis.reviewQueue.filter((item) => item.reason.startsWith("UNMATCHED_SPEECH")),
    transcriptQuality: { basis: "unreviewed acoustic ASR", humanConfirmedTimingCount: analysis.observations.filter((item) => item.groundTruth === "human").length,
      wordErrorRate: null, characterErrorRate: null, humanVerifiedWrongAlignmentCount: null,
      summary: analysis.transcript.slice(0, 6).map((span) => ({ startMs: span.startMs, endMs: span.endMs, text: span.text })) },
    baseline: comparison?.baseline ?? null, candidate: comparison?.candidate ?? null,
    comparisonBasis: comparison?.evaluationKind ?? "No evaluable alignment",
    candidateProfile: { generated: !!comparison, sampleCount: 1, status: "candidate", promoted: false,
      profileCount: comparison?.profiles.length ?? 0, fallbackEnabled: comparison?.profiles.filter((profile) => profile.fallback.enabled).length ?? 0 },
    cueRows: rows, productionReady: false,
    nextAction: "Listen and human-review repetition/transitions/misses; compare independent rehearsal and provider results before promotion.",
  };
}

export function formatASRBenchmarkReport(report: ReturnType<typeof buildASRBenchmark>): string {
  const list = (values: string[]) => values.length ? values.join(", ") : "없음";
  const json = (value: unknown) => `\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
  const section = (number: number, title: string, body: string) => `## ${number}. ${title}\n\n${body}\n`;
  return [`# ${report.provider} / 실제 리허설 ASR 보고서`,
    "ASR observation / machine alignment / human-confirmed timing은 서로 다릅니다. 아래 정렬·coverage는 인간 정답 정확도가 아닙니다.",
    section(1, "Provider / model", `${report.provider} / ${report.model}`),
    section(2, "원본 WAV", json(report.inspection)),
    section(3, "전사 wall time", `${report.transcriptionWallTimeMs.toFixed(1)} ms — 배치 요청 처리 시간이며 live latency가 아닙니다.`),
    section(4, "ASR segments", String(report.segmentCount)),
    section(5, "단어 시각·신뢰도", `${report.wordCount} words, ${report.segmentsWithWordTimestamps}/${report.segmentCount} spans.\n${json(report.wordConfidence)}신뢰도 unavailable은 null이며 임의 숫자를 넣지 않았습니다.`),
    section(6, "인식 전사 요약", json(report.transcriptQuality.summary)),
    section(7, "Canonical cues", String(report.canonicalCueCount)),
    section(8, "정렬 큐", `${report.alignedCueCount} unique cues / ${report.observationCount} observations; machine coverage ${report.canonicalCueCoverage === null ? "N/A" : (report.canonicalCueCoverage * 100).toFixed(1) + "%"}`),
    section(9, "미관측 큐", list(report.missedCueIds)),
    section(10, "검토·경고", `검토: ${list(report.reviewRequiredCueIds)}\n\n경고: ${list(report.warningCueIds)}\n\nReview items: ${report.reviewRequiredCount}`),
    section(11, "반복 오프닝", json(report.repeatedLyrics)),
    section(12, "A → B 대사 전환", json(report.transitions.filter((transition) => transition.sections === "A → B"))),
    section(13, "B → C 가창 전환", json(report.transitions.filter((transition) => transition.sections === "B → C"))),
    section(14, "합창·듀엣", json(report.chorus)),
    section(15, "첫 음절·내부 앵커", `내부 텍스트 근거 후보이며 실제 첫 음절 누락의 인간 판정은 아닙니다.${json(report.internalRecoveries)}`),
    section(16, "UNMATCHED_SPEECH", json(report.unmatchedRegions)),
    section(17, "현재 matcher baseline", `${report.comparisonBasis}${json(report.baseline?.metrics ?? null)}`),
    section(18, "Candidate 적용 결과", `같은 엔진 + 한 녹음으로 만든 프로필. 독립 검증이나 개선 보장이 아닙니다.${json(report.candidate?.metrics ?? null)}`),
    section(19, "수동 개입 후보", `미관측/검토 큐: ${list([...new Set([...report.missedCueIds, ...report.reviewRequiredCueIds])])}. 실제 공연 개입 횟수를 측정한 것은 아닙니다.`),
    section(20, "Candidate Cue Profile", json(report.candidateProfile)),
    section(21, "Fallback", `${report.candidateProfile.fallbackEnabled} enabled; 단일 녹음은 OFF, 자동 승격 없음.`),
    section(22, "실공연 준비 결론", `NOT PRODUCTION READY. Human-confirmed timings: ${report.transcriptQuality.humanConfirmedTimingCount}. ${report.nextAction}`),
  ].join("\n\n") + "\n";
}
