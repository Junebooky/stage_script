export interface LatencySnapshot {
  last: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  samples: number;
}

export class LatencyTracker {
  private samples: number[] = [];

  record(valueMs: number): LatencySnapshot {
    if (Number.isFinite(valueMs) && valueMs >= 0) {
      this.samples.push(valueMs);
      if (this.samples.length > 500) this.samples.shift();
    }
    return this.snapshot();
  }

  reset(): void {
    this.samples = [];
  }

  snapshot(): LatencySnapshot {
    if (!this.samples.length) return { last: null, p50: null, p95: null, p99: null, samples: 0 };
    const sorted = [...this.samples].sort((left, right) => left - right);
    const percentile = (ratio: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)]!;
    return {
      last: this.samples[this.samples.length - 1]!,
      p50: percentile(0.5),
      p95: percentile(0.95),
      p99: percentile(0.99),
      samples: this.samples.length
    };
  }
}

