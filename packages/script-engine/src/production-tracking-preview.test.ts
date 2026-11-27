import { describe, expect, it } from "vitest";
import type { ProductionPackageDraft } from "@stage/script-schema";
import { ProductionTrackingPreview } from "./production-tracking-preview";

function fixture(): ProductionPackageDraft {
  const a = { actId: "a", sceneId: "s", sourceRefs: ["synthetic"] };
  const lyrics = ["푸르른 하늘을 바라봐", "잔잔한 물결을 따라", "새벽빛이 세상을 비추네", "저녁노을 멀리 사라져", "고요한 별들이 반짝여"];
  return {
    version: 1, status: "draft", productionId: "fixture", revisionId: "r1", title: "Fixture", locale: "ko-KR",
    design: { aspectRatio: { width: 16, height: 9 }, background: "#000000", foreground: "#FFFFFF", fontFamily: "Pretendard", verticalAlign: "CENTER", preferredRows: 2 },
    acts: [{ id: "a", title: "Act 1" }], songs: [],
    frames: [
      { ...a, id: "loc", kind: "TEXT", role: "LOCATION", columns: [{ rows: ["광장"] }], trigger: { kind: "MANUAL" } },
      { ...a, id: "black", kind: "BLACK", trigger: { kind: "MANUAL" } },
      { ...a, id: "f1", kind: "TEXT", role: "LYRIC", columns: [{ rows: lyrics.slice(0, 2) }], trigger: { kind: "SPEECH", cueId: "c1" } },
      { ...a, id: "f2", kind: "TEXT", role: "LYRIC", columns: [{ rows: [lyrics[2]!] }], trigger: { kind: "SPEECH", cueId: "c3" } },
      { ...a, id: "f3", kind: "TEXT", role: "LYRIC", columns: [{ rows: [lyrics[3]!] }], trigger: { kind: "SPEECH", cueId: "c4" } },
      { ...a, id: "break", kind: "BLACK", trigger: { kind: "MANUAL" } },
      { ...a, id: "f4", kind: "TEXT", role: "LYRIC", columns: [{ rows: [lyrics[4]!] }], trigger: { kind: "SPEECH", cueId: "c5" } },
    ],
    trackingCues: [
      { ...a, id: "d1", kind: "DIALOGUE", frameId: "black", matchText: ["오늘은 이만 돌아가자"], performers: ["A"] },
      ...lyrics.map((line, i) => ({ ...a, id: "c" + (i + 1), kind: "LYRIC" as const, frameId: ["f1", "f1", "f2", "f3", "f4"][i]!, matchText: [line], performers: ["A"] })),
    ],
  };
}
function setup(p = fixture()) {
  const c = new ProductionTrackingPreview(p);
  expect(c.selectAct("a")).toBe(true);
  expect(c.manualShow("loc")).toBe(true);
  expect(c.blackAuto("black")).toBe(true);
  return c;
}
function feed(c: ProductionTrackingPreview, text: string, sequence: number, options: { epoch?: { sessionId: string; generation: number }; at?: number; verified?: boolean; stream?: string; saved?: boolean } = {}) {
  const epoch = options.epoch ?? c.snapshot();
  return c.processHypothesis({ sessionId: epoch.sessionId, generation: epoch.generation, sequence,
    hypothesis: { text, confidence: 1, isFinal: false, speechActive: true, boundaryVerified: options.verified ?? true,
      receivedAt: options.at ?? sequence * 1000, streamId: options.stream ?? "utterance-" + sequence,
      ...(options.saved ? { evidenceBasis: "saved-completed-words" as const } : {}) } });
}
function ready(c: ProductionTrackingPreview) { expect(c.acknowledgeRecognitionReset(c.snapshot())).toBe(true); }
function first(c: ProductionTrackingPreview) { ready(c); expect(feed(c, "푸르", 1)).toBe("matched"); }
describe("draft preview with the real existing matcher (synthetic ASR events, no audio)", () => {
  it("requires reset acknowledgment and verified audio generation before matching", () => {
    const c = setup();
    expect(feed(c, "푸르", 1)).toBe("ignored");
    ready(c);
    expect(feed(c, "푸르", 1, { verified: false })).toBe("ignored");
    expect(feed(c, "푸르", 1, { saved: true })).toBe("ignored");
    expect(c.snapshot().view).toEqual({ kind: "BLACK" });
    expect(feed(c, "푸르", 1)).toBe("matched");
    expect(c.snapshot().frameId).toBe("f1");
  });
  it("keeps location locked and rejects old generation after manual takeover", () => {
    const c = setup();
    const old = c.snapshot();
    ready(c);
    c.manualShow("loc");
    expect(feed(c, "푸르", 1, { epoch: old })).toBe("ignored");
    expect(c.snapshot().mode).toBe("LOCATION_LOCK");
    c.blackAuto("black");
    expect(c.acknowledgeRecognitionReset(old)).toBe(false);
    ready(c);
    expect(feed(c, "푸르", 10, { epoch: old })).toBe("ignored");
    expect(feed(c, "푸르", 1)).toBe("matched");
  });
  it("tracks two lyrics without changing their shared frame", () => {
    const c = setup();
    first(c);
    const view = c.snapshot().view;
    expect(feed(c, "잔잔한 물결을 따라", 2)).toBe("matched");
    expect(c.snapshot().view).toEqual(view);
    expect(c.snapshot().trackingCueId).toBe("c2");
    expect(feed(c, "새벽빛이 세상을 비추네", 3)).toBe("matched");
    expect(c.snapshot().frameId).toBe("f2");
  });
  it("does not skip the first frame on a future lyric", () => {
    const c = setup();
    ready(c);
    expect(feed(c, "잔잔한 물결을 따라", 1)).toBe("listening");
    expect(c.snapshot().view).toEqual({ kind: "BLACK" });
  });
  it("preserves the nearby dialogue as negative early-evidence context", () => {
    const p = fixture();
    p.trackingCues[0]!.matchText = ["푸르른 나무가 보이는군"];
    const c = setup(p);
    ready(c);
    expect(feed(c, "푸르", 1)).toBe("listening");
    expect(c.snapshot().view).toEqual({ kind: "BLACK" });
  });
  it("allows the existing validated one-cue lookahead only if skipped cue was already visible", () => {
    const c = setup();
    first(c);
    expect(feed(c, "새벽빛이 세상을 비추네", 2, { at: 10000 })).toBe("matched");
    expect(c.snapshot().trackingCueId).toBe("c3");
    expect(c.snapshot().frameId).toBe("f2");
  });
  it("holds rather than omit an unseen output frame on a validated engine skip", () => {
    const c = setup();
    first(c);
    expect(feed(c, "잔잔한 물결을 따라", 2)).toBe("matched");
    expect(feed(c, "저녁노을 멀리 사라져", 3, { at: 12000 })).toBe("blocked");
    expect(c.snapshot().mode).toBe("HOLD");
    expect(c.snapshot().fault).toBe("FRAME_GATE_REJECTED");
    expect(c.snapshot().frameId).toBe("f1");
    expect(feed(c, "저녁노을 멀리 사라져", 4, { at: 13000 })).toBe("ignored");
    expect(c.resumeAuto("c3")).toBe(true);
    ready(c);
    expect(feed(c, "새벽빛이 세상을 비추네", 1)).toBe("matched");
  });
  it("cannot match beyond the next manual black boundary", () => {
    const c = setup();
    first(c);
    expect(feed(c, "잔잔한 물결을 따라", 2)).toBe("matched");
    expect(feed(c, "새벽빛이 세상을 비추네", 3)).toBe("matched");
    expect(feed(c, "저녁노을 멀리 사라져", 4)).toBe("matched");
    expect(feed(c, "고요한 별들이 반짝여", 5)).toBe("listening");
    expect(c.snapshot().frameId).toBe("f3");
    expect(c.blackAuto("break")).toBe(true);
    ready(c);
    expect(feed(c, "고요한 별들이 반짝여", 1)).toBe("matched");
    expect(c.snapshot().frameId).toBe("f4");
  });
  it("rejects duplicate and out-of-order events before the existing matcher", () => {
    const c = setup();
    first(c);
    expect(feed(c, "잔잔한 물결을 따라", 1)).toBe("ignored");
    expect(feed(c, "잔잔한 물결을 따라", 2, { at: 999 })).toBe("ignored");
    expect(feed(c, "잔잔한 물결을 따라", 2)).toBe("matched");
  });
  it("does not cascade to the next frame on a revision of consumed early evidence", () => {
    const c = setup();
    ready(c);
    expect(feed(c, "푸르", 1, { stream: "same" })).toBe("matched");
    expect(feed(c, "잔잔한 물결을 따라 새벽빛이 세상을 비추네", 2, { stream: "same" })).toBe("listening");
    expect(c.snapshot().trackingCueId).toBe("c1");
    expect(c.snapshot().frameId).toBe("f1");
  });
  it("keeps hidden dialogue and raw recognition out of the frame view", () => {
    const c = setup();
    ready(c);
    expect(feed(c, "오늘은 이만 돌아가자", 1)).toBe("listening");
    expect(c.snapshot().view).toEqual({ kind: "BLACK" });
    expect(feed(c, "푸르", 2)).toBe("matched");
    expect(JSON.stringify(c.snapshot().view)).not.toMatch(/오늘은 이만|matchText|hypothesis|sourceRefs/);
    expect(JSON.stringify(c.snapshot().view)).toContain("푸르른 하늘을 바라봐");
  });
});
