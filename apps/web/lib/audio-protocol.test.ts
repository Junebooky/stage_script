import { describe, expect, it } from "vitest";
import { decodeAudioHypothesis } from "./audio-protocol";

describe("backend partial message boundary", () => {
  it("maps the backend's snake_case partial and uses the browser clock", () => {
    expect(decodeAudioHypothesis(JSON.stringify({
      type: "hypothesis", text: "어둠이 길어져도", confidence: 0.92, is_final: false, timestamp_ms: 999999
    }), 123)).toMatchObject({ text: "어둠이 길어져도", confidence: 0.92, isFinal: false, receivedAt: 123 });
  });
  it("ignores non-ASR, malformed and incomplete messages", () => {
    for (const raw of ["bad-json", '{"type":"ready"}', '{"type":"hypothesis","text":"x"}']) {
      expect(decodeAudioHypothesis(raw, 123)).toBeNull();
    }
  });
});
