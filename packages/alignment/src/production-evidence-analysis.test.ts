import { describe, expect, it } from "vitest";
import type { ProductionPackageDraft } from "@stage/script-schema";
import { analyzeProductionEvidence } from "./production-evidence-analysis";

function fixture(lines: string[][], locale = "ko-KR"): ProductionPackageDraft {
  const a = { actId: "a", sceneId: "s", sourceRefs: ["synthetic"] };
  return {
    version: 1, status: "draft", productionId: "sample", revisionId: "r1", title: "Sample", locale,
    design: { aspectRatio: { width: 16, height: 9 }, background: "#000000", foreground: "#FFFFFF", fontFamily: "Pretendard", verticalAlign: "CENTER", preferredRows: 2 },
    acts: [{ id: "a", title: "Act 1" }], songs: [],
    frames: [
      { ...a, id: "loc", kind: "TEXT", role: "LOCATION", columns: [{ rows: ["광장"] }], trigger: { kind: "MANUAL" } },
      { ...a, id: "black", kind: "BLACK", trigger: { kind: "MANUAL" } },
    ],
    trackingCues: lines.map((matchText, i) => ({ ...a, id: "c" + i, kind: "LYRIC", matchText, performers: ["A"] })),
  };
}
const first = (lines: string[][], locale?: string) => analyzeProductionEvidence(fixture(lines, locale)).cues[0]!.alternatives[0]!;
describe("script-only production evidence report", () => {
  it("uses the existing matcher to identify a distinctive short prefix without confidence or audio", () => {
    const r = first([["푸르른 하늘을 바라봐"]]);
    expect(r.recommendation).toBe("EARLY_CANDIDATE");
    expect(r.prefixProbes[0]).toMatchObject({ prefix: "푸르", earlyEvidence: true, matcherAccepted: true, exactNearbyCueIds: [], jamoNearbyCueIds: [] });
  });
  it("does not claim early evidence for weak function-word openings or tiny lyrics", () => {
    expect(first([["우리 함께 걸어가자"]]).recommendation).toBe("WAIT_FOR_MORE");
    expect(first([["사랑"]]).prefixProbes).toEqual([]);
    expect(first([["사랑"]]).recommendation).toBe("WAIT_FOR_MORE");
  });
  it("uses hidden spoken dialogue as a competing negative example", () => {
    const p = fixture([["푸르른 하늘을 바라봐"], ["푸르른 나무가 보인다"]]);
    p.trackingCues[1]!.kind = "DIALOGUE";
    const r = analyzeProductionEvidence(p).cues[0]!.alternatives[0]!;
    expect(r.prefixProbes[0]).toMatchObject({ prefix: "푸르", earlyEvidence: false, exactNearbyCueIds: ["c1"] });
    expect(r.recommendation).toBe("WAIT_FOR_MORE");
  });
  it("flags repetitions across an act even beyond the live nearby matcher window", () => {
    const r = first([["푸르른 하늘을 바라봐"], ["잔잔한 물결"], ["고요한 밤"], ["새벽 노을"], ["푸르른 하늘을 바라봐!"]]);
    expect(r.exactRepeatCueIds).toEqual(["c4"]);
    expect(r.nearbyRepeatCueIds).toEqual([]);
    expect(r.recommendation).toBe("REVIEW_REPEAT");
  });
  it("flags normalized near repeats without counting alternatives in the same cue", () => {
    const r = first([["푸르른 하늘", "푸르른 하늘!"], ["푸르른하늘"]]);
    expect(r.exactRepeatCueIds).toEqual(["c1"]);
    expect(r.nearbyRepeatCueIds).toEqual(["c1"]);
    expect(r.recommendation).toBe("REVIEW_REPEAT");
    expect(first([["푸르른 하늘", "푸르른 하늘!"]]).exactRepeatCueIds).toEqual([]);
  });
  it("flags a one-slot Hangul spelling neighbor independently of matcher acceptance", () => {
    const r = first([["불러요 그 노래를"], ["풀러요 묶인 끈을"]]);
    expect(r.prefixProbes[0]).toMatchObject({ prefix: "불러", earlyEvidence: true, exactNearbyCueIds: [], jamoNearbyCueIds: ["c1"] });
    expect(r.prefixProbes[1]).toMatchObject({ prefix: "불러요", jamoNearbyCueIds: ["c1"] });
    expect(r.recommendation).toBe("REVIEW_JAMO");
  });
  it("does not group identical cues from different acts as same-act repeats", () => {
    const p = fixture([["푸르른 하늘"], ["푸르른 하늘"]]);
    p.acts.push({ id: "b", title: "Act 2" });
    p.trackingCues[1]!.actId = "b";
    const report = analyzeProductionEvidence(p);
    expect(report.cues.map(c => c.alternatives[0]!.exactRepeatCueIds)).toEqual([[], []]);
  });
  it("does not assign Korean early-evidence recommendations to unsupported locales", () => {
    const r = first([["I love the sky"]], "en-US");
    expect(r.recommendation).toBe("REVIEW_UNSUPPORTED_LOCALE");
    expect(r.prefixProbes).toEqual([]);
  });
  it("flags text emptied by normalization instead of inventing match text", () => {
    const r = first([["..."]]);
    expect(r.normalizedLength).toBe(0);
    expect(r.recommendation).toBe("REVIEW_NO_EVIDENCE");
  });
  it("reports manual frame coverage and revision without modifying the package or producing timing profiles", () => {
    const p = fixture([["푸르른 하늘을 바라봐"]]);
    p.frames.push({ id: "f", actId: "a", sceneId: "s", sourceRefs: ["synthetic"], kind: "TEXT", role: "LYRIC",
      columns: [{ rows: ["푸르른 하늘을 바라봐"] }], trigger: { kind: "SPEECH", cueId: "c0" } });
    p.trackingCues[0]!.frameId = "f";
    const before = structuredClone(p);
    const r = analyzeProductionEvidence(p);
    expect(p).toEqual(before);
    expect(r).toEqual(analyzeProductionEvidence(p));
    expect(r).toMatchObject({ version: 1, productionId: "sample", revisionId: "r1", acousticValidated: false, evidenceBasis: "SCRIPT_ONLY_SYNTHETIC", manualFrameIds: ["loc", "black"], speechFrameIds: ["f"] });
    expect(r.cues[0]).toMatchObject({ cueId: "c0", frameId: "f" });
    expect(JSON.stringify(r)).not.toMatch(/medianAfterPreviousMs|sampleCount|productionReady|thresholds/);
  });
});
