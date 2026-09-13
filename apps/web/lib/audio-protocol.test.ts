import { describe, expect, it } from "vitest";
import { decodeAudioHypothesis, RecognitionGenerationGate } from "./audio-protocol";

describe("backend partial message boundary", () => {
  it("retires pre-navigation inference until the exact new audio generation is acknowledged", () => {
    const gate = new RecognitionGenerationGate();
    expect(gate.accepts(0)).toBe(true);
    expect(gate.advance()).toBe(1);
    expect(gate.accepts(0)).toBe(false);
    expect(gate.accepts(1)).toBe(false);
    expect(gate.acknowledge(0)).toBe(false);
    expect(gate.acknowledge(1)).toBe(true);
    expect(gate.accepts(1)).toBe(true);
    expect(gate.accepts(0)).toBe(false);
    gate.advance();
    expect(gate.acknowledge(1)).toBe(false);
    expect(gate.accepts(1)).toBe(false);
  });
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
