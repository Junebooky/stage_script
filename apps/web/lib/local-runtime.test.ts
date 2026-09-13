import { describe, expect, it } from "vitest";
import { localBackendUrl, performanceSocketUrl } from "./local-runtime";

describe("performance has no external backend fallback", () => {
  it("routes local speech explicitly to performance mode", () => {
    expect(performanceSocketUrl()).toBe("ws://localhost:8000/ws/audio?mode=performance");
    expect(localBackendUrl("/readiness")).toBe("http://localhost:8000/readiness");
  });
  it("rejects configured cloud URLs instead of sending microphone audio there", () => {
    expect(() => performanceSocketUrl("wss://speech.example.com/ws/audio")).toThrow(/LOCAL ASR UNAVAILABLE/);
    expect(() => localBackendUrl("/readiness", "https://api.example.com")).toThrow(/loopback/);
  });
});
