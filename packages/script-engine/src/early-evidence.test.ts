import { describe, expect, it } from "vitest";
import { DiscriminativeWordMatcher } from "@stage/alignment";
import type { PerformanceScript } from "@stage/script-schema";
import { ScriptFollowingEngine } from "./index";

function setup(lines: string[]) {
  const script: PerformanceScript = { title: "Synthetic early-evidence safety", locale: "ko-KR", segments: lines.map((text, index) => ({ id: String(index), order: index + 1, type: "CAPTION", matchText: [text], captions: [{ actor: "A", text }] })) };
  const engine = new ScriptFollowingEngine(script, new DiscriminativeWordMatcher(), { operatingMode: "PERFORMANCE_LOCAL", profiles: [] });
  engine.arm();
  const send = (text: string, at: number, utteranceId = "one") => engine.processHypothesis({ text, receivedAt: at, utteranceId, confidence: null, confidenceBasis: "unavailable", speechActive: true, isFinal: false, evidenceBasis: "saved-completed-words" });
  return { engine, send, script };
}

describe("engine authority with opt-in early evidence", () => {
  it("retires an early prefix and its cumulative tail, preserving canonical captions", () => {
    const { engine, send, script } = setup(["창가로 스며드는 외로운 달빛", "외로운 별이여 쉬어 가게"]);
    expect(send("창가로", 100).currentIndex).toBe(0);
    expect(send("창가로 스며드는 외로운", 200).currentIndex).toBe(0);
    expect(send("창가로 스며드는 외로운 달빛", 300).currentIndex).toBe(0);
    expect(send("창가로 스며드는 외로운 달빛 외로운 별이여", 400).currentIndex).toBe(1);
    expect(engine.snapshot().displayedSegment?.captions).toEqual(script.segments[1]!.captions);
    expect(engine.snapshot().lastTrigger?.source).toBe("automatic");
  });
  it("does not advance on previous near-identical lyrics in a fresh ASR span", () => {
    const { send } = setup(["우리는 함께 걸어와", "우리는 함께 걸어가"]);
    expect(send("우리는 함께 걸어와", 100).currentIndex).toBe(0);
    expect(send("우리는", 200, "fresh").currentIndex).toBe(0);
    expect(send("우리는 함께 걸어와", 300, "fresh").currentIndex).toBe(0);
    expect(send("우리는 함께 걸어가", 400, "correct").currentIndex).toBe(1);
  });
  it("requires new occurrence evidence for identical adjacent lyrics, not a final revision", () => {
    const text = "창가로 스며드는 달빛";
    const { send } = setup([text, text]);
    expect(send("창가로", 100).currentIndex).toBe(-1);
    expect(send(text, 200).currentIndex).toBe(0);
    expect(send(text + "!", 300).currentIndex).toBe(0);
    expect(send(text + " " + text, 400).currentIndex).toBe(1);
  });
  it("HOLD and manual checkpoints do not replay old short evidence", () => {
    const { engine, send } = setup(["창가로 스며드는 달빛", "내게로 와요", "잠들지 말아요"]);
    expect(send("창가로", 100).currentIndex).toBe(0);
    engine.setHold(true, 150); send("창가로 내게로", 200); engine.setHold(false, 250);
    expect(send("창가로 내게로!", 300).currentIndex).toBe(0);
    engine.manualNext(350);
    expect(send("창가로 내게로", 400).currentIndex).toBe(1);
    expect(send("창가로 내게로 잠들지", 450).currentIndex).toBe(2);
    expect(engine.exportTelemetry().filter((t) => t.event === "trigger").map((t) => t.source)).toEqual(["automatic", "manual", "automatic"]);
  });
  it("noise cannot widen the pointer and post-take speech cannot create a cue", () => {
    const { engine, send } = setup(["창가로 스며드는 달빛", "잠들지 말아요"]);
    for (let n = 0; n < 20; n++) send("잠들지", n * 100, String(n));
    expect(engine.snapshot().currentIndex).toBe(-1);
    expect(engine.snapshot().searchMode).toBe("NORMAL");
    send("창가로", 2100, "start"); send("잠들지", 2200, "next");
    const trigger = engine.snapshot().lastTrigger;
    send("감사합니다", 2300, "post");
    expect(engine.snapshot().lastTrigger).toBe(trigger);
  });
});
