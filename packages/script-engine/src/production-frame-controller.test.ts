import { describe, expect, it } from "vitest";
import type { ProductionPackageDraft } from "@stage/script-schema";
import { ProductionFrameController } from "./production-frame-controller";

function fixture(): ProductionPackageDraft {
  const a = { actId: "a", sceneId: "s", sourceRefs: ["synthetic-fixture"] };
  const b = { actId: "b", sceneId: "s2", sourceRefs: ["synthetic-fixture"] };
  return {
    version: 1, status: "draft", productionId: "fixture", revisionId: "r1", title: "Fixture", locale: "ko-KR",
    design: { aspectRatio: { width: 16, height: 9 }, background: "#000000", foreground: "#FFFFFF", fontFamily: "Pretendard", verticalAlign: "CENTER", preferredRows: 2 },
    acts: [{ id: "a", title: "Act 1" }, { id: "b", title: "Act 2" }], songs: [],
    frames: [
      { ...a, id: "start", kind: "BLACK", trigger: { kind: "MANUAL" } },
      { ...a, id: "location", kind: "TEXT", role: "LOCATION", columns: [{ rows: ["광장"] }], trigger: { kind: "MANUAL" } },
      { ...a, id: "dialogue", kind: "BLACK", trigger: { kind: "MANUAL" } },
      { ...a, id: "song1", kind: "TEXT", role: "LYRIC", columns: [{ actor: "A", rows: ["첫 가사", "둘째 가사"] }, { actor: "B", rows: [null, "함께"] }], trigger: { kind: "SPEECH", cueId: "c1" } },
      { ...a, id: "song2", kind: "TEXT", role: "LYRIC", columns: [{ rows: ["다음 가사"] }], trigger: { kind: "SPEECH", cueId: "c3" } },
      { ...a, id: "break", kind: "BLACK", trigger: { kind: "MANUAL" } },
      { ...a, id: "song3", kind: "TEXT", role: "LYRIC", columns: [{ rows: ["다시 시작"] }], trigger: { kind: "SPEECH", cueId: "c4" } },
      { ...b, id: "b-song", kind: "TEXT", role: "LYRIC", columns: [{ rows: ["다음 막"] }], trigger: { kind: "SPEECH", cueId: "b1" } },
    ],
    trackingCues: [
      { ...a, id: "d1", kind: "DIALOGUE", frameId: "dialogue", matchText: ["관객에게 표시하지 않는 대사"], performers: ["A"] },
      { ...a, id: "c1", kind: "LYRIC", frameId: "song1", matchText: ["첫 가사"], performers: ["A"] },
      { ...a, id: "c2", kind: "LYRIC", frameId: "song1", matchText: ["둘째 가사", "함께"], performers: ["A", "B"] },
      { ...a, id: "c3", kind: "LYRIC", frameId: "song2", matchText: ["다음 가사"], performers: ["A"] },
      { ...a, id: "c4", kind: "LYRIC", frameId: "song3", matchText: ["다시 시작"], performers: ["A"] },
      { ...b, id: "b1", kind: "LYRIC", frameId: "b-song", matchText: ["다음 막"], performers: ["B"] },
    ],
  };
}
function controller() {
  const c = new ProductionFrameController(fixture());
  expect(c.selectAct("a")).toBe(true);
  return c;
}
function match(c: ProductionFrameController, cueId: string, sequence: number, generation = c.snapshot().generation) {
  return c.acceptMatch({ cueId, sequence, generation });
}
function firstSong(c: ProductionFrameController) {
  expect(c.blackAuto("dialogue")).toBe(true);
  expect(match(c, "c1", 1)).toBe(true);
}
describe("experimental production frame controller", () => {
  it("starts black and refuses matches without explicit act selection", () => {
    const c = new ProductionFrameController(fixture());
    expect(c.snapshot().view).toEqual({ kind: "BLACK" });
    expect(match(c, "c1", 1)).toBe(false);
    expect(c.manualNext()).toBe(false);
  });
  it("manually selects silent location and keeps it locked", () => {
    const c = controller();
    expect(c.manualShow("location")).toBe(true);
    const s = c.snapshot();
    expect(s.mode).toBe("LOCATION_LOCK");
    expect(match(c, "c1", 1)).toBe(false);
    expect(c.resumeAuto("c1")).toBe(false);
    expect(c.snapshot()).toEqual(s);
  });
  it("black lock cannot be overridden even by a fresh matched cue", () => {
    const c = controller();
    firstSong(c);
    c.forceBlack();
    const s = c.snapshot();
    expect(s.mode).toBe("BLACK_LOCK");
    expect(s.view).toEqual({ kind: "BLACK" });
    expect(match(c, "c2", 2)).toBe(false);
    expect(c.resumeAuto("c2")).toBe(false);
    expect(c.snapshot()).toEqual(s);
  });
  it("black auto waits for the exact next frame's first cue only", () => {
    const c = controller();
    expect(c.blackAuto("start")).toBe(false); // next is manual location
    expect(c.blackAuto("dialogue")).toBe(true);
    expect(c.snapshot().expectedCueId).toBe("c1");
    expect(match(c, "d1", 1)).toBe(false);
    expect(match(c, "c2", 2)).toBe(false);
    expect(match(c, "c4", 3)).toBe(false);
    expect(c.snapshot().view).toEqual({ kind: "BLACK" });
    expect(match(c, "c1", 4)).toBe(true);
    expect(c.snapshot().mode).toBe("AUTO_LIVE");
    expect(c.snapshot().frameId).toBe("song1");
  });
  it("keeps identical canonical view across multiple cues of one frame", () => {
    const c = controller();
    firstSong(c);
    const view = c.snapshot().view;
    expect(match(c, "c2", 2)).toBe(true);
    expect(c.snapshot().view).toEqual(view);
    expect(c.snapshot().trackingCueId).toBe("c2");
    expect(match(c, "c3", 3)).toBe(true);
    expect(c.snapshot().frameId).toBe("song2");
  });
  it("never crosses an unacknowledged scheduled manual black barrier", () => {
    const c = controller();
    firstSong(c);
    expect(match(c, "c2", 2)).toBe(true);
    expect(match(c, "c3", 3)).toBe(true);
    expect(match(c, "c4", 4)).toBe(false);
    expect(c.snapshot().frameId).toBe("song2");
    expect(c.blackAuto("break")).toBe(true);
    expect(match(c, "c4", 1)).toBe(true);
    expect(c.snapshot().frameId).toBe("song3");
  });
  it("rejects queued results from before a manual override and rearm", () => {
    const c = controller();
    expect(c.blackAuto("dialogue")).toBe(true);
    const old = c.snapshot().generation;
    c.manualShow("location");
    c.blackAuto("dialogue");
    expect(match(c, "c1", 99, old)).toBe(false);
    expect(c.snapshot().view).toEqual({ kind: "BLACK" });
    expect(match(c, "c1", 1)).toBe(true);
  });
  it("rejects duplicate, reordered and invalid sequence numbers", () => {
    const c = controller();
    firstSong(c);
    expect(match(c, "c2", 1)).toBe(false);
    expect(match(c, "c2", Number.NaN)).toBe(false);
    expect(match(c, "c2", -1)).toBe(false);
    expect(match(c, "c2", 2)).toBe(true);
    expect(match(c, "c3", 1)).toBe(false);
    expect(match(c, "c3", 3)).toBe(true);
  });
  it("holds the current frame and requires an explicit fresh resume", () => {
    const c = controller();
    firstSong(c);
    const old = c.snapshot().generation;
    const view = c.snapshot().view;
    c.hold();
    expect(match(c, "c2", 2)).toBe(false);
    expect(c.snapshot().view).toEqual(view);
    expect(c.resumeAuto("c4")).toBe(false);
    expect(c.resumeAuto("c2")).toBe(true);
    expect(match(c, "c2", 3, old)).toBe(false);
    expect(match(c, "c2", 1)).toBe(true);
  });
  it("allows manual frame navigation without any ASR readiness", () => {
    const c = controller();
    expect(c.manualNext()).toBe(true);
    expect(c.snapshot().frameId).toBe("start");
    expect(c.manualNext()).toBe(true);
    expect(c.snapshot().frameId).toBe("location");
    expect(c.manualPrevious()).toBe(true);
    expect(c.snapshot().frameId).toBe("start");
    expect(c.manualPrevious()).toBe(false);
    expect(c.manualShow("song3")).toBe(true);
    expect(c.manualNext()).toBe(false);
  });
  it("does not cross act boundaries or revive a completed act", () => {
    const c = controller();
    expect(c.manualShow("b-song")).toBe(false);
    expect(c.blackAuto("break")).toBe(true);
    expect(match(c, "c4", 1)).toBe(true);
    expect(match(c, "b1", 2)).toBe(false);
    const old = c.snapshot().generation;
    c.endAct();
    expect(c.snapshot().view).toEqual({ kind: "BLACK" });
    expect(c.selectAct("b")).toBe(true);
    expect(c.manualShow("b-song")).toBe(true);
    expect(c.resumeAuto("b1")).toBe(true);
    expect(match(c, "b1", 9, old)).toBe(false);
    expect(match(c, "b1", 1)).toBe(true);
  });
  it("exposes only canonical view and does not allow caller mutation", () => {
    const p = fixture();
    const c = new ProductionFrameController(p);
    c.selectAct("a");
    firstSong(c);
    const view = c.snapshot().view;
    if (view.kind !== "TEXT") throw new Error("bad fixture");
    view.columns[0]!.rows[0] = "injected";
    const original = p.frames[3]!;
    if (original.kind !== "TEXT") throw new Error("bad fixture");
    original.columns[0]!.rows[0] = "injected";
    expect(JSON.stringify(c.snapshot().view)).not.toMatch(/injected|관객에게 표시하지 않는 대사|matchText|sourceRefs/);
    expect(JSON.stringify(c.snapshot().view)).toContain("첫 가사");
  });
});
