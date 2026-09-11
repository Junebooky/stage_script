import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptFollowingEngine } from "@stage/script-engine";
import { demoScript } from "@stage/script-schema";
import { BrowserSpeechASRAdapter } from "./browser-speech-asr";

class FakeRecognizer {
  static instance: FakeRecognizer;
  continuous = false;
  interimResults = false;
  lang = "";
  maxAlternatives = 0;
  onstart?: () => void;
  onend?: () => void;
  onerror?: (event: { error: string }) => void;
  onresult?: (event: unknown) => void;
  start = vi.fn(() => this.onstart?.());
  abort = vi.fn(() => this.onend?.());
  constructor() { FakeRecognizer.instance = this; }
  emit(text: string, final = false, index = 0) {
    this.onresult?.({
      resultIndex: index,
      results: Object.assign({ length: index + 1 }, {
        [index]: { isFinal: final, length: 1, 0: { transcript: text, confidence: 0.91 } }
      })
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("window", { SpeechRecognition: FakeRecognizer });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("live speech recognition adapter", () => {
  it("delivers interim text with a stable utterance id and suppresses duplicated finals", () => {
    const receive = vi.fn();
    const adapter = new BrowserSpeechASRAdapter(receive, vi.fn());
    adapter.start();
    FakeRecognizer.instance.emit("어둠이 길");
    FakeRecognizer.instance.emit("어둠이 길어져도", true);
    FakeRecognizer.instance.emit("어둠이 길어져도", true);
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive.mock.calls[0]![0].isFinal).toBe(false);
    expect(receive.mock.calls[0]![0].utteranceId).toBe(receive.mock.calls[1]![0].utteranceId);
  });
  it("keeps network failure visible after end and never loops permission retries", () => {
    const status = vi.fn();
    const adapter = new BrowserSpeechASRAdapter(vi.fn(), status);
    adapter.start();
    FakeRecognizer.instance.onerror?.({ error: "network" });
    FakeRecognizer.instance.onend?.();
    vi.advanceTimersByTime(3000);
    expect(FakeRecognizer.instance.start).toHaveBeenCalledTimes(1);
    expect(status.mock.lastCall?.[0]).toBe("error");
    expect(status.mock.lastCall?.[1]).toContain("서버에 연결하지 못했습니다");
  });
  it("restarts after silence, but cancels pending restarts and late results on stop", () => {
    const receive = vi.fn();
    const adapter = new BrowserSpeechASRAdapter(receive, vi.fn());
    adapter.start();
    FakeRecognizer.instance.onend?.();
    vi.advanceTimersByTime(200);
    expect(FakeRecognizer.instance.start).toHaveBeenCalledTimes(2);
    FakeRecognizer.instance.onend?.();
    adapter.stop();
    vi.advanceTimersByTime(200);
    FakeRecognizer.instance.emit("종료 후 늦게 도착한 문장");
    expect(FakeRecognizer.instance.start).toHaveBeenCalledTimes(2);
    expect(receive).not.toHaveBeenCalled();
  });
  it("reports unsupported browsers instead of silently doing nothing", () => {
    vi.stubGlobal("window", {});
    const status = vi.fn();
    new BrowserSpeechASRAdapter(vi.fn(), status).start();
    expect(status.mock.lastCall?.[0]).toBe("unavailable");
  });
  it("emits interims immediately and preserves context across ASR result boundaries", () => {
    const engine = new ScriptFollowingEngine(demoScript);
    const receive = vi.fn((hypothesis) => engine.processHypothesis(hypothesis));
    const adapter = new BrowserSpeechASRAdapter(receive, vi.fn());
    adapter.start();
    FakeRecognizer.instance.emit("어", true, 0);
    FakeRecognizer.instance.emit("둠", false, 1);
    expect(receive).toHaveBeenCalledTimes(2);
    expect(receive.mock.lastCall?.[0].contextText).toBe("어둠");
    expect(receive.mock.lastCall?.[0].text).toBe("둠");
    expect(receive.mock.calls[0]![0].streamId).toBe(receive.mock.lastCall?.[0].streamId);
    expect(receive.mock.lastCall?.[0].isFinal).toBe(false);
    expect(engine.snapshot().currentIndex).toBe(0);
  });
});
