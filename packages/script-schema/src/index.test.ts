import { describe, expect, it } from "vitest";
import { demoScript, demoShow, flattenShow, isLocalImageSource, parseCueProfile, parseScript, parseShow } from "./index";

describe("script schema", () => {
  it("loads ordered demo segments", () => {
    expect(demoScript.segments).toHaveLength(16);
    expect(demoScript.segments.map((segment) => segment.order)).toEqual([...demoScript.segments.map((segment) => segment.order)].sort((a, b) => a - b));
  });

  it("requires two captions for overlap", () => {
    expect(() => parseScript({
      title: "bad",
      locale: "ko-KR",
      segments: [{ id: "1", order: 1, type: "OVERLAP", captions: [{ actor: "A", text: "x" }], matchText: ["x"] }]
    })).toThrow(/at least two/);
  });

  it("requires one display caption for chorus", () => {
    expect(() => parseScript({
      title: "bad",
      locale: "ko-KR",
      segments: [{
        id: "1",
        order: 1,
        type: "CHORUS",
        captions: [{ actor: "A", text: "x" }, { actor: "B", text: "x" }],
        matchText: ["x"]
      }]
    })).toThrow(/exactly one/);
  });

  it("migrates the existing demo into acts and numbers without changing canonical captions", () => {
    expect(demoShow.acts).toHaveLength(2);
    const flat = flattenShow(demoShow);
    expect(flat.segments.map((cue) => cue.captions)).toEqual(demoScript.segments.map((cue) => cue.captions));
    expect(flat.segments.every((cue) => cue.metadata?.actId && cue.metadata.numberId)).toBe(true);
    expect(flat.segments[0]!.type).toBe("CAPTION");
    expect(parseShow(demoScript).acts).toHaveLength(2);
  });

  it("validates IMAGE assets and disallows speech text on explicit image cues", () => {
    const cue = { id: "image", order: 1, type: "IMAGE", captions: [], matchText: [], image: { src: "/show/night.webp", alt: "Night sky" } };
    expect(parseScript({ title: "Images", locale: "ko-KR", segments: [cue] }).segments[0]?.type).toBe("IMAGE");
    for (const src of ["https://example.com/a.png", "//example.com/a.png", "/../a.png", "/%2e%2e/a.png", "/%252e%252e/a.png", "/a.svg", "/a.png?remote=1", "/a%20b.png", "/a b.png"]) expect(isLocalImageSource(src), src).toBe(false);
    expect(() => parseScript({ title: "Images", locale: "ko-KR", segments: [{ ...cue, matchText: ["silence"] }] })).toThrow(/cannot contain/);
  });

  it("rejects canonical content exceeding audience and local storage limits at import time", () => {
    expect(() => parseShow({ ...demoShow, id: "a".repeat(201) })).toThrow(/200/);
    expect(() => parseScript({ ...demoScript, segments: [{ ...demoScript.segments[0], captions: [{ actor: "A", text: "x".repeat(4001) }] }] })).toThrow(/invalid caption/);
    expect(() => parseScript({ ...demoScript, segments: [{ ...demoScript.segments[0], captions: Array.from({ length: 9 }, () => ({ actor: "A", text: "line" })) }] })).toThrow(/eight/);
  });

  it("rejects duplicate cue ids across acts and non-finite profiles", () => {
    const show = structuredClone(demoShow);
    show.acts[1]!.numbers[0]!.cues[0]!.id = show.acts[0]!.numbers[0]!.cues[0]!.id;
    expect(() => parseShow(show)).toThrow(/Duplicate cue/);
    expect(() => parseCueProfile({ cueId: "a", anchors: [], timing: { medianAfterPreviousMs: Infinity, earlyToleranceMs: 0, lateToleranceMs: 0, varianceMs2: 0 }, thresholds: { text: 0.8, fallback: 0.9 }, fallback: { enabled: false }, sampleCount: 1, confidence: 0.9 })).toThrow(/timing/);
  });
});
