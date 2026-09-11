import { describe, expect, it } from "vitest";
import { demoScript, parseScript } from "./index";

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
});

