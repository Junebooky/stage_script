import { describe, expect, it } from "vitest";
import { LatencyTracker } from "./index";

describe("latency instrumentation", () => {
  it("reports last and percentile values instead of only an average", () => {
    const tracker = new LatencyTracker();
    [80, 100, 120, 140, 300].forEach((sample) => tracker.record(sample));
    expect(tracker.snapshot()).toEqual({ last: 300, p50: 120, p95: 300, p99: 300, samples: 5 });
  });

  it("keeps a bounded sample window", () => {
    const tracker = new LatencyTracker();
    for (let value = 0; value < 520; value += 1) tracker.record(value);
    expect(tracker.snapshot().samples).toBe(500);
  });
});

