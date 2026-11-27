import { describe, expect, it } from "vitest";
import { parseProductionPackageDraft, type ProductionPackageDraft } from "./production-package";

function fixture(): ProductionPackageDraft {
  const base = { actId: "a1", sceneId: "s1", sourceRefs: ["fixture"] };
  return {
    version: 1, status: "draft", productionId: "sample", revisionId: "r1", title: "Sample", locale: "ko-KR",
    design: { aspectRatio: { width: 16, height: 9 }, background: "#000000", foreground: "#FFFFFF", fontFamily: "Pretendard", verticalAlign: "CENTER", preferredRows: 2 },
    acts: [{ id: "a1", title: "Act 1" }],
    songs: [{ id: "stable-song", displayNumber: "M07", title: "Song" }],
    frames: [
      { ...base, id: "location", kind: "TEXT", role: "LOCATION", columns: [{ rows: ["어느 날, 광장"] }], trigger: { kind: "MANUAL" } },
      { ...base, id: "black", kind: "BLACK", trigger: { kind: "MANUAL" } },
      { ...base, id: "lyrics", kind: "TEXT", role: "LYRIC", columns: [{ actor: "A", rows: ["첫 가사", "둘째 가사"] }, { actor: "B", rows: [null, "함께"] }], trigger: { kind: "SPEECH", cueId: "c1" } },
    ],
    trackingCues: [
      { ...base, id: "d1", kind: "DIALOGUE", frameId: "black", performers: ["A"], matchText: ["이제 시작하자"] },
      { ...base, id: "c1", kind: "LYRIC", songId: "stable-song", frameId: "lyrics", performers: ["A"], matchText: ["첫 가사"] },
      { ...base, id: "c2", kind: "LYRIC", songId: "stable-song", frameId: "lyrics", performers: ["A", "B"], matchText: ["둘째 가사", "함께"] },
    ],
  };
}
describe("draft production package", () => {
  it("accepts manual location and black frames without fake recognition text", () => {
    const parsed = parseProductionPackageDraft(fixture());
    expect(parsed.frames.slice(0, 2).map(f => f.trigger)).toEqual([{ kind: "MANUAL" }, { kind: "MANUAL" }]);
    expect(parsed.trackingCues.some(c => c.frameId === "location")).toBe(false);
    expect(parsed.frames[1]).not.toHaveProperty("matchText");
  });
  it("keeps dialogue private and preserves aligned empty rows", () => {
    const parsed = parseProductionPackageDraft(fixture());
    expect(parsed.trackingCues[0]?.matchText).toEqual(["이제 시작하자"]);
    expect(JSON.stringify(parsed.frames)).not.toContain("이제 시작하자");
    const frame = parsed.frames[2];
    expect(frame?.kind === "TEXT" && frame.columns[1]?.rows).toEqual([null, "함께"]);
    expect(parsed.trackingCues.slice(1).map(c => c.frameId)).toEqual(["lyrics", "lyrics"]);
  });
  it("rejects a trigger on the second cue of a frame", () => {
    const p = fixture();
    p.frames[2]!.trigger = { kind: "SPEECH", cueId: "c2" };
    expect(() => parseProductionPackageDraft(p)).toThrow(/first associated cue/);
  });
  it("rejects missing references and blank tracking evidence", () => {
    const p = fixture();
    p.trackingCues[1]!.frameId = "missing";
    expect(() => parseProductionPackageDraft(p)).toThrow(/frame reference/);
    const q = fixture();
    q.trackingCues[0]!.matchText = [];
    expect(() => parseProductionPackageDraft(q)).toThrow(/speech evidence/);
  });
  it("rejects collapsed columns and duplicate frame identifiers", () => {
    const p = fixture();
    const f = p.frames[2]!;
    if (f.kind !== "TEXT") throw new Error("bad fixture");
    f.columns[1]!.rows = ["함께"];
    expect(() => parseProductionPackageDraft(p)).toThrow(/Column rows/);
    const q = fixture();
    q.frames[1]!.id = q.frames[0]!.id;
    expect(() => parseProductionPackageDraft(q)).toThrow(/Duplicate frame/);
  });
  it("supports other show designs and keeps song identity separate from display number", () => {
    const p = fixture();
    p.design = { ...p.design, verticalAlign: "BOTTOM", preferredRows: 3, background: "#222222", fontFamily: "Other Font" };
    const first = parseProductionPackageDraft(p);
    p.revisionId = "r2";
    p.songs[0]!.displayNumber = "M09";
    const second = parseProductionPackageDraft(p);
    expect(second.design).toEqual(first.design);
    expect(second.songs[0]?.id).toBe(first.songs[0]?.id);
    expect(first.songs[0]?.displayNumber).toBe("M07");
    expect(second.songs[0]?.displayNumber).toBe("M09");
  });
  it("does not accept a live-approved status or copy untrusted extra fields", () => {
    expect(() => parseProductionPackageDraft({ ...fixture(), status: "approved" })).toThrow(/draft/);
    const p = fixture();
    const parsed = parseProductionPackageDraft({ ...p, asrText: "untrusted", frames: p.frames.map(f => ({ ...f, asrText: "untrusted" })) });
    expect(JSON.stringify(parsed)).not.toContain("untrusted");
  });
  it("does not allow a speech trigger from a different frame", () => {
    const p = fixture();
    p.frames[0]!.trigger = { kind: "SPEECH", cueId: "c1" };
    expect(() => parseProductionPackageDraft(p)).toThrow(/first associated cue/);
  });
});
