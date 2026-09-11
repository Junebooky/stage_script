import { test, expect, type Page } from "@playwright/test";

const firstLine = "어둠이 길어져도 우리는 이 무대를 떠나지 않아";
const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(({ page }) => { expect(browserErrors.get(page)).toEqual([]); });

// These tests exercise real Web Audio/AudioWorklet and the UI. ASR is deliberately
// synthetic: they test the wiring, not acoustic accuracy or a cloud service.
async function installAudioFixture(page: Page, supported = true) {
  await page.addInitScript(({ supported }) => {
    let recognizer: FakeRecognition | null = null;
    let gain: GainNode | null = null;
    let stopped = false;
    class FakeRecognition {
      continuous = false;
      interimResults = false;
      lang = "";
      onstart?: () => void;
      onend?: () => void;
      onerror?: (event: { error: string }) => void;
      onresult?: (event: unknown) => void;
      constructor() { recognizer = this; }
      start() { queueMicrotask(() => this.onstart?.()); }
      stop() { this.onend?.(); }
      abort() { this.onend?.(); }
    }
    Object.defineProperty(window, "SpeechRecognition", { configurable: true, value: supported ? FakeRecognition : undefined });
    Object.defineProperty(window, "webkitSpeechRecognition", { configurable: true, value: undefined });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => {
        const context = new AudioContext();
        await context.resume();
        const oscillator = context.createOscillator();
        oscillator.frequency.value = 220;
        gain = context.createGain();
        gain.gain.value = 0.08;
        const destination = context.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination);
        oscillator.start();
        const track = destination.stream.getAudioTracks()[0]!;
        const originalStop = track.stop.bind(track);
        track.stop = () => {
          stopped = true;
          originalStop();
          oscillator.stop();
          void context.close();
        };
        return destination.stream;
      }
    });
    Object.assign(window, {
      captionFixture: {
        emit(text: string, index = 0, final = false) {
          recognizer?.onresult?.({
            resultIndex: index,
            results: Object.assign({ length: index + 1 }, {
              [index]: { isFinal: final, length: 1, 0: { transcript: text, confidence: 0.96 } }
            })
          });
        },
        error(error: string) { recognizer?.onerror?.({ error }); recognizer?.onend?.(); },
        silence() { if (gain) gain.gain.value = 0; },
        stopped() { return stopped; }
      }
    });
  }, { supported });
}

async function emit(page: Page, text: string, index = 0, final = false) {
  await page.evaluate(({ text, index, final }) => {
    (window as unknown as { captionFixture: { emit(text: string, index: number, final: boolean): void } }).captionFixture.emit(text, index, final);
  }, { text, index, final });
}

test("all 16 cues advance from two-syllable interims without a single final result or manual cue", async ({ page }) => {
  await installAudioFixture(page);
  await page.routeWebSocket("**/ws/audio", (socket) => socket.send(JSON.stringify({ type: "ready", adapter: "mock-streaming-asr" })));
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop microphone", exact: true })).toBeVisible();
  const prefixes = ["어둠", "한걸", "내목", "지금", "그래", "난준", "숨을", "다시", "다시", "나는", "들려", "우리", "멀리", "잃어", "멈춰", "그러"];
  const timings: number[] = [];
  for (const [index, text] of prefixes.entries()) {
    const id = `seg-${String(index + 1).padStart(3, "0")}`;
    const elapsed = await page.evaluate(({ text, index, id }) => new Promise<number>((resolve, reject) => {
      const started = performance.now();
      const observer = new MutationObserver(() => {
        if (document.querySelector('[aria-label="Prepared caption"]')?.getAttribute("data-segment") !== id) return;
        observer.disconnect();
        clearTimeout(timeout);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - started)));
      });
      const timeout = setTimeout(() => { observer.disconnect(); reject(new Error(`No early cue for ${id}`)); }, 1500);
      observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      (window as unknown as { captionFixture: { emit(text: string, index: number, final: boolean): void } }).captionFixture.emit(text, index, false);
    }), { text, index, id });
    timings.push(elapsed);
    await expect(page.getByLabel("Prepared caption", { exact: true })).toHaveAttribute("data-segment", id);
    await expect(page.locator(`[data-cue="${id}"]`)).toHaveAttribute("data-state", "on-air");
    if (index === 1) await page.screenshot({ path: "/tmp/cueflow-two-syllable-proof.png" });
  }
  expect(Math.max(...timings)).toBeLessThan(200);
  await expect(page.getByRole("progressbar", { name: "Completed captions" })).toHaveAttribute("aria-valuenow", "15");
  const sorted = [...timings].sort((left, right) => left - right);
  console.info(`Synthetic interim-to-paint: median ${sorted[8]!.toFixed(1)} ms, maximum ${Math.max(...timings).toFixed(1)} ms; 16 / 16 automatic cues, zero final results.`);
});

test("late sentence completion cannot block the next cue or replay a cue already shown", async ({ page }) => {
  await installAudioFixture(page);
  await page.routeWebSocket("**/ws/audio", (socket) => socket.send(JSON.stringify({ type: "ready", adapter: "mock-streaming-asr" })));
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop microphone", exact: true })).toBeVisible();
  await emit(page, "어둠");
  await expect(page.getByLabel("Prepared caption", { exact: true })).toHaveAttribute("data-segment", "seg-001");
  await emit(page, "어둠이 길어져도 우린 이 무대 떠나지 않아 한걸");
  await expect(page.getByLabel("Prepared caption", { exact: true })).toHaveAttribute("data-segment", "seg-002");
  const revision = `${firstLine} 한 걸음 뒤에는 또 다른 길이 열릴 테니까 내목`;
  await emit(page, revision);
  await expect(page.getByLabel("Prepared caption", { exact: true })).toHaveAttribute("data-segment", "seg-003");
  await emit(page, `${firstLine} 한 걸음 뒤에는 또 다른 길이 열릴 테니까 내 목소리를 따라와`, 0, true);
  await expect(page.getByLabel("Prepared caption", { exact: true })).toHaveAttribute("data-segment", "seg-003");
  await emit(page, "지금", 1);
  await expect(page.getByLabel("Prepared caption", { exact: true })).toHaveAttribute("data-segment", "seg-004");
});

test("microphone audio drives the waveform; partial speech cues prepared text and shows what was heard", async ({ page }) => {
  await installAudioFixture(page);
  await page.routeWebSocket("**/ws/audio", (socket) => socket.send(JSON.stringify({ type: "ready", adapter: "mock-streaming-asr" })));
  await page.goto("/demo");
  await expect(page.getByLabel("Prepared caption preview")).toContainText(firstLine);
  await expect(page.getByRole("img", { name: "Microphone audio waveform" })).toBeVisible();
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  const waveform = page.getByRole("img", { name: "Microphone audio waveform" });
  await expect.poll(async () => Number(await waveform.getAttribute("data-level"))).toBeGreaterThan(0.05);

  await emit(page, "어둠이 길어져도");
  await expect(page.getByLabel("Prepared caption", { exact: true })).toHaveAttribute("data-segment", "seg-001");
  await expect(page.getByLabel("Prepared caption", { exact: true })).toContainText(firstLine);
  await expect(page.getByLabel("Recognized speech")).toContainText("어둠이 길어져도");
  const output = page.getByRole("region", { name: "Stage caption output", exact: true });
  const monitor = page.getByRole("region", { name: "Microphone recognition monitor", exact: true });
  await expect(output).toHaveAttribute("data-source", "automatic");
  await expect(output).toHaveAttribute("data-state", "on-air");
  await expect(monitor.getByLabel("Recognized speech")).toHaveText("어둠이 길어져도");
  await expect(output.getByLabel("Recognized speech")).toHaveCount(0);
  await expect(page.locator('[data-cue="seg-001"]')).toHaveAttribute("data-state", "on-air");
  await expect(page.locator('[data-cue="seg-002"]')).toContainText("자막 대기중");
  await expect(waveform).toBeInViewport();
  await expect(page.getByLabel("Prepared caption", { exact: true })).toBeInViewport();
  await emit(page, firstLine);
  await expect(page.getByLabel("Prepared caption", { exact: true })).toHaveAttribute("data-segment", "seg-001");

  await page.evaluate(() => (window as unknown as { captionFixture: { silence(): void } }).captionFixture.silence());
  await expect.poll(async () => Number(await waveform.getAttribute("data-level"))).toBe(0);
  await page.getByRole("button", { name: "Stop microphone", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { captionFixture: { stopped(): boolean } }).captionFixture.stopped())).toBe(true);
  await expect(page.getByLabel("Prepared caption", { exact: true })).toContainText(firstLine);
});

test("reset with the microphone still live ignores a delayed final and re-arms for fresh speech", async ({ page }) => {
  await installAudioFixture(page);
  await page.routeWebSocket("**/ws/audio", (socket) => socket.send(JSON.stringify({ type: "ready", adapter: "mock-streaming-asr" })));
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop microphone", exact: true })).toBeVisible();
  await emit(page, "어둠이 길어져도");
  await expect(page.getByLabel("Prepared caption", { exact: true })).toHaveAttribute("data-segment", "seg-001");
  await page.getByRole("button", { name: "Reset performance", exact: true }).click();
  await emit(page, "어둠이 길어져도", 0, true);
  await expect(page.getByRole("region", { name: "Stage caption output", exact: true })).toHaveAttribute("data-state", "standby");
  await emit(page, "어둠", 1);
  await expect(page.getByLabel("Prepared caption", { exact: true })).toHaveAttribute("data-segment", "seg-001");
});

test("the presenter can cue, complete, rewind and reset without treating microphone text as output", async ({ page }) => {
  await page.goto("/demo");
  const output = page.getByRole("region", { name: "Stage caption output", exact: true });
  await expect(output).toHaveAttribute("data-state", "standby");
  await expect(page.locator('[data-cue="seg-001"]')).toHaveAttribute("data-state", "waiting");
  await expect(page.locator('[data-cue="seg-002"]')).toContainText("한 걸음 뒤에는");
  await page.getByRole("button", { name: "Send next cue", exact: true }).click();
  await expect(output).toHaveAttribute("data-source", "manual");
  await expect(page.locator('[data-cue="seg-001"]')).toHaveAttribute("data-state", "on-air");
  await page.getByRole("button", { name: "Send next cue", exact: true }).click();
  await expect(page.locator('[data-cue="seg-001"]')).toHaveAttribute("data-state", "complete");
  await expect(page.locator('[data-cue="seg-001"]')).toContainText("Complete");
  await expect(page.locator('[data-cue="seg-002"]')).toHaveAttribute("data-state", "on-air");
  await expect(page.locator('[data-cue="seg-003"]')).toContainText("자막 대기중");
  await expect(page.getByRole("progressbar", { name: "Completed captions" })).toHaveAttribute("aria-valuenow", "1");
  await page.getByRole("button", { name: "Previous cue", exact: true }).click();
  await expect(page.getByRole("progressbar", { name: "Completed captions" })).toHaveAttribute("aria-valuenow", "0");
  await expect(page.locator('[data-cue="seg-002"]')).toHaveAttribute("data-state", "waiting");
  await page.getByRole("button", { name: "Reset performance", exact: true }).click();
  await expect(output).toHaveAttribute("data-state", "standby");
  await expect(page.locator('[data-cue="seg-001"]')).toHaveAttribute("data-state", "waiting");
  await expect(page.getByRole("region", { name: "Realtime caption metrics" })).toContainText("0.0%");
});

test("a second spoken cue completes the first while keeping raw partials separate from full stage captions", async ({ page }) => {
  await installAudioFixture(page);
  await page.routeWebSocket("**/ws/audio", (socket) => socket.send(JSON.stringify({ type: "ready", adapter: "mock-streaming-asr" })));
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop microphone", exact: true })).toBeVisible();
  await emit(page, "어둠이 길어져도");
  await expect(page.locator('[data-cue="seg-001"]')).toHaveAttribute("data-state", "on-air");
  await emit(page, "한 걸음 뒤에는", 1);
  await expect(page.getByLabel("Prepared caption", { exact: true })).toHaveAttribute("data-segment", "seg-002");
  await expect(page.getByLabel("Recognized speech")).toHaveText("한 걸음 뒤에는");
  await expect(page.getByLabel("Prepared caption", { exact: true })).toHaveText("한 걸음 뒤에는 또 다른 길이 열릴 테니까");
  await expect(page.locator('[data-cue="seg-001"]')).toHaveAttribute("data-state", "complete");
  await expect(page.locator('[data-cue="seg-002"]')).toHaveAttribute("data-state", "on-air");
  await expect(page.locator('[data-cue="seg-003"]')).toContainText("자막 대기중");
});

test("the last cue has an explicit Complete state and keeps the final stage caption", async ({ page }) => {
  await page.goto("/demo");
  for (let index = 0; index < 16; index += 1) {
    await page.getByRole("button", { name: "Send next cue", exact: true }).click();
  }
  await expect(page.getByRole("region", { name: "Stage caption output", exact: true })).toHaveAttribute("data-state", "on-air");
  await page.getByRole("button", { name: "Complete final cue", exact: true }).click();
  await expect(page.getByRole("region", { name: "Stage caption output", exact: true })).toHaveAttribute("data-state", "complete");
  await expect(page.locator('[data-cue="seg-016"]')).toHaveAttribute("data-state", "complete");
  await expect(page.getByRole("progressbar", { name: "Completed captions" })).toHaveAttribute("aria-valuenow", "16");
  await expect(page.getByLabel("Prepared caption", { exact: true })).toContainText("그러니 마지막 음까지 내 곁에 있어 줘");
});

test("unmatched microphone words remain input-only and hold never completes or advances a cue", async ({ page }) => {
  await installAudioFixture(page);
  await page.routeWebSocket("**/ws/audio", (socket) => socket.send(JSON.stringify({ type: "ready", adapter: "mock-streaming-asr" })));
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop microphone", exact: true })).toBeVisible();
  await emit(page, "무대와 관계없는 마이크 테스트입니다");
  await expect(page.getByLabel("Recognized speech")).toContainText("무대와 관계없는");
  await expect(page.getByLabel("Prepared caption preview")).toHaveText(firstLine);
  await page.getByRole("button", { name: "Hold automatic cues", exact: true }).click();
  await emit(page, firstLine, 1);
  await expect(page.getByRole("region", { name: "Stage caption output", exact: true })).toContainText("HOLD");
  await expect(page.getByLabel("Prepared caption preview")).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Completed captions" })).toHaveAttribute("aria-valuenow", "0");
  await page.getByRole("button", { name: "Resume automatic cues", exact: true }).click();
  await emit(page, firstLine, 1);
  await expect(page.getByLabel("Prepared caption", { exact: true })).toHaveAttribute("data-segment", "seg-001");
});

test("an unsupported ASR shows an actionable reason while the microphone still animates", async ({ page }) => {
  await installAudioFixture(page, false);
  await page.routeWebSocket("**/ws/audio", (socket) => socket.send(JSON.stringify({ type: "ready", adapter: "mock-streaming-asr" })));
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("음성 인식을 지원하지 않습니다");
  await expect.poll(async () => Number(await page.getByRole("img", { name: "Microphone audio waveform" }).getAttribute("data-level"))).toBeGreaterThan(0);
  await expect(page.getByLabel("Prepared caption preview")).toContainText(firstLine);
});

test("recognition failure stays visible instead of looking like a silent successful connection", async ({ page }) => {
  await installAudioFixture(page);
  await page.routeWebSocket("**/ws/audio", (socket) => socket.send(JSON.stringify({ type: "ready", adapter: "mock-streaming-asr" })));
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop microphone", exact: true })).toBeVisible();
  await page.evaluate(() => (window as unknown as { captionFixture: { error(code: string): void } }).captionFixture.error("network"));
  await expect(page.getByRole("status")).toContainText("음성 인식 서버에 연결하지 못했습니다");
});

test("PCM reaches the socket and backend partials reach the same caption engine without browser ASR", async ({ page }) => {
  await installAudioFixture(page, false);
  let pcmFrames = 0;
  await page.routeWebSocket("**/ws/audio", (socket) => {
    socket.send(JSON.stringify({ type: "ready", adapter: "test-streaming-asr" }));
    socket.onMessage((message) => {
      if (typeof message === "string") return;
      pcmFrames += 1;
      if (pcmFrames === 5) socket.send(JSON.stringify({
        type: "hypothesis", text: "어둠이 길어져도", confidence: 0.95, is_final: false, timestamp_ms: 100
      }));
    });
  });
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await expect(page.getByLabel("Prepared caption", { exact: true })).toHaveAttribute("data-segment", "seg-001");
  await expect(page.getByLabel("Recognized speech")).toContainText("어둠이 길어져도");
  expect(pcmFrames).toBeGreaterThanOrEqual(5);
});

test("microphone permission denial keeps the caption visible and explains the missing input", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async () => { throw new DOMException("Permission denied", "NotAllowedError"); }
    });
  });
  await page.goto("/demo");
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("마이크 권한이 차단되었습니다");
  await expect(page.getByLabel("Prepared caption preview")).toContainText(firstLine);
  await expect(page.getByRole("img", { name: "Microphone audio waveform" })).toHaveAttribute("data-level", "0.000");
});

test("short viewports shrink the gyroid before pushing bottom captions offscreen", async ({ page }) => {
  for (const viewport of [{ width: 1280, height: 720 }, { width: 375, height: 667 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/demo");
    await expect(page.getByLabel("Prepared caption preview")).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("img", { name: "Microphone audio waveform" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole("button", { name: "Start microphone", exact: true })).toBeInViewport({ ratio: 1 });
  }
});

test("mobile retains waveform and captions; overlap renders both prepared lines", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/demo");
  await expect(page.getByLabel("Prepared caption preview")).toBeInViewport();
  await expect(page.getByRole("img", { name: "Microphone audio waveform" })).toBeInViewport();
  await page.goto("/demo?debug=true");
  await page.getByRole("button", { name: "OVERLAP", exact: true }).click();
  await expect(page.getByLabel("Prepared caption", { exact: true })).toHaveAttribute("data-segment", "seg-010");
  await expect(page.getByText("나는 끝까지 문을 두드릴게", { exact: true })).toBeVisible();
  await expect(page.getByText("나는 먼저 불을 밝힐게", { exact: true })).toBeVisible();
  await expect(page.getByRole("img", { name: "Microphone audio waveform" })).toBeVisible();
});
