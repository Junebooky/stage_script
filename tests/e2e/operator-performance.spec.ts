import { test, expect, type BrowserContext, type Page, type WebSocketRoute } from "@playwright/test";

const show = {
  id: "offline-test-show", title: "로컬 공연 검증", locale: "ko-KR",
  acts: [
    { id: "act-1", title: "1막", numbers: [{ id: "m01", title: "첫 장면", cues: [
      { id: "a1", order: 1, type: "CAPTION", captions: [{ actor: "A", text: "첫 번째 확정 자막" }], matchText: ["첫 번째 확정 자막"] },
      { id: "a2", order: 2, type: "OVERLAP", captions: [{ actor: "A", text: "함께 부르는 노래" }, { actor: "B", text: "서로 다른 확정 자막" }], matchText: ["함께 부르는 노래", "서로 다른 확정 자막"] }
    ] }] },
    { id: "act-2", title: "2막", numbers: [{ id: "m19", title: "다음 장면", cues: [
      { id: "b1", order: 1, type: "CAPTION", captions: [{ actor: "A", text: "이막은 GO 이후에만" }], matchText: ["이막은 GO 이후에만"] }
    ] }] }
  ]
};

async function offlineBackend(context: BrowserContext, localReady = false) {
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) return route.abort();
    if (url.port === "8000") return route.fulfill({ json: { status: localReady ? "LOCAL ASR READY" : "LOCAL ASR UNAVAILABLE", local_ready: localReady, reason: localReady ? undefined : "No local model", champion: null, challengers: [] }, headers: { "access-control-allow-origin": "*" } });
    return route.continue();
  });
  await context.addInitScript(() => {
    Object.assign(window, { SpeechRecognition: class { constructor() { throw new Error("Performance must not instantiate cloud/browser ASR"); } } });
  });
}

async function loadShow(page: Page, canonical = show) {
  await page.goto("/operator");
  await page.getByLabel("Performance ASR source").selectOption("local");
  await page.getByLabel("Import canonical show").setInputFiles({ name: "canonical-show.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(canonical)) });
  await expect(page.getByRole("heading", { name: canonical.title })).toBeVisible();
}

test("offline manual performance mirrors only canonical output and requires intermission ARM GO", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await offlineBackend(context);
  await loadShow(page);
  const audience = await context.newPage();
  await audience.goto("/output");
  const output = audience.getByRole("main", { name: "Audience caption output" });
  await expect(output).toHaveAttribute("data-kind", "black");
  await page.getByRole("checkbox", { name: "수동 운용 · 자동 인식 끄기" }).check();
  await page.getByRole("button", { name: "Arm next act" }).click();
  await expect(page.getByRole("button", { name: "Go act" })).toBeEnabled();
  await page.getByRole("button", { name: "Go act" }).click();
  await page.getByRole("button", { name: "Send next cue" }).click();
  await expect(output).toHaveAttribute("data-cue", "a1");
  await expect(output).toHaveText("첫 번째 확정 자막");
  await page.getByRole("button", { name: "Send next cue" }).click();
  await expect(output).toHaveAttribute("data-cue", "a2");
  await expect(output).toContainText("서로 다른 확정 자막");
  await page.getByRole("button", { name: "Complete act" }).click();
  await expect(page.getByLabel("Show lifecycle")).toHaveAttribute("data-show-state", "ACT_COMPLETE");
  await page.getByRole("button", { name: "Enter intermission" }).click();
  await expect(output).toHaveAttribute("data-kind", "black");
  await expect(page.getByRole("button", { name: "Complete act" })).toBeDisabled();
  await page.keyboard.press("ArrowRight");
  await expect(output).toHaveAttribute("data-kind", "black");
  await page.getByRole("button", { name: "Arm next act" }).click();
  await expect(page.getByLabel("Show lifecycle")).toHaveAttribute("data-show-state", "ACT_ARMED");
  await expect(output).toHaveAttribute("data-kind", "black");
  await page.getByRole("button", { name: "Go act" }).click();
  await expect(output).toHaveAttribute("data-kind", "black");
  await page.getByRole("button", { name: "Send next cue" }).click();
  await expect(output).toHaveText("이막은 GO 이후에만");
  await expect(audience.getByRole("button")).toHaveCount(0);
  await expect(audience.getByText(/MIC INPUT|MANUAL|LOCAL ASR|DEBUG/)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("unavailable local ASR blocks automatic GO and never falls back to browser speech", async ({ page, context }) => {
  await offlineBackend(context);
  await loadShow(page);
  const audience = await context.newPage();
  await audience.goto("/output");
  await page.getByRole("button", { name: "Arm next act" }).click();
  await expect(page.getByRole("button", { name: "Go act" })).toBeDisabled();
  await expect(page.getByText(/LOCAL ASR UNAVAILABLE/)).toBeVisible();
  await expect(audience.getByRole("main")).toHaveAttribute("data-kind", "black");
});

test("a saved canonical revision sharing the demo ID initializes the actual runtime on reload", async ({ page, context }) => {
  await offlineBackend(context);
  const saved = { ...show, id: "demo-show" };
  await context.addInitScript((canonical) => localStorage.setItem("cueflow-canonical-show-v1", JSON.stringify(canonical)), saved);
  await page.goto("/operator");
  await expect(page.getByRole("heading", { name: saved.title })).toBeVisible();
  const audience = await context.newPage();
  await audience.goto("/output");
  await page.getByRole("checkbox", { name: "수동 운용 · 자동 인식 끄기" }).check();
  await page.getByRole("button", { name: "Arm next act" }).click();
  await page.getByRole("button", { name: "Go act" }).click();
  await page.getByRole("button", { name: "Send next cue" }).click();
  await expect(audience.getByRole("main")).toHaveAttribute("data-cue", "a1");
  await expect(audience.getByRole("main")).toHaveText("첫 번째 확정 자막");
});

test("a second operator cannot acquire authority or advance the audience pointer", async ({ page, context }) => {
  await offlineBackend(context);
  await loadShow(page);
  await expect(page.getByRole("button", { name: "Arm next act" })).toBeEnabled();
  const second = await context.newPage();
  await second.goto("/operator");
  await expect(second.getByRole("main").getByRole("alert")).toContainText("다른 운영 창");
  await expect(second.getByRole("button", { name: "Arm next act" })).toBeDisabled();
  await expect(second.getByRole("button", { name: "Send next cue" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Arm next act" })).toBeEnabled();
});

test("local interims cue canonical output, while manual reset ACK fences delayed old audio", async ({ page, context }) => {
  // Synthetic local ASR protocol + Chromium fake microphone: not an acoustic benchmark.
  await offlineBackend(context, true);
  await context.grantPermissions(["microphone"]);
  let socket: WebSocketRoute | undefined;
  let generation = 0;
  let autoAcknowledge = true;
  let pcmFrames = 0;
  await page.routeWebSocket("**/ws/audio?mode=performance", (route) => {
    socket = route;
    route.send(JSON.stringify({ type: "ready", adapter: "local-test-fixture", local_ready: true, reset_generation: true, generation: 0 }));
    route.onMessage((message) => {
      if (typeof message !== "string") { pcmFrames++; return; }
      const payload = JSON.parse(message);
      if (payload.type !== "reset") return;
      generation = payload.generation;
      if (autoAcknowledge) route.send(JSON.stringify({ type: "reset_ack", generation }));
    });
  });
  const canonical = structuredClone(show);
  canonical.acts[0]!.numbers[0]!.cues.push({ id: "a3", order: 3, type: "CAPTION", captions: [{ actor: "A", text: "마지막 불빛이 우리를 비춘다" }], matchText: ["마지막 불빛이 우리를 비춘다"] });
  await loadShow(page, canonical);
  const audience = await context.newPage();
  await audience.goto("/output");
  const output = audience.getByRole("main", { name: "Audience caption output" });
  await page.getByRole("button", { name: "Arm next act" }).click();
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await expect(page.getByRole("button", { name: "Go act" })).toBeEnabled();
  await page.getByRole("button", { name: "Go act" }).click();
  await expect.poll(() => generation).toBe(1);
  await expect.poll(() => pcmFrames).toBeGreaterThan(0);
  const emit = (text: string, audioGeneration: number, final = false) => socket!.send(JSON.stringify({ type: "hypothesis", text, confidence: 0.99, is_final: final, generation: audioGeneration, stream_id: `audio-${audioGeneration}`, utterance_id: `utterance-${audioGeneration}` }));
  emit("첫 번째 확정", 1);
  await expect(output).toHaveAttribute("data-cue", "a1");
  await expect(output).toHaveText("첫 번째 확정 자막");
  await expect(page.getByLabel("Recognized speech")).toHaveText("첫 번째 확정");

  autoAcknowledge = false;
  await page.getByRole("button", { name: "Send next cue" }).click();
  await expect(output).toHaveAttribute("data-cue", "a2");
  await expect.poll(() => generation).toBe(2);
  emit("마지막 불빛이 우리를 비춘다", 1, true);
  emit("마지막 불빛이 우리를 비춘다", 2); // ACK has not arrived: also forbidden.
  await expect(page.getByLabel("Recognized speech")).toHaveText("첫 번째 확정");
  await expect(output).toHaveAttribute("data-cue", "a2");
  socket!.send(JSON.stringify({ type: "reset_ack", generation: 2 }));
  emit("이전 세대의 뒤늦은 확정 문장", 1, true);
  emit("마지막 불빛이", 2);
  await expect(output).toHaveAttribute("data-cue", "a3");
  await expect(output).toHaveText("마지막 불빛이 우리를 비춘다");
  await expect(page.getByLabel("Recognized speech")).toHaveText("마지막 불빛이");
  await expect(page.getByRole("region", { name: "Stage caption output", exact: true })).toHaveAttribute("data-source", "automatic");
  await page.getByRole("button", { name: "Stop microphone", exact: true }).click();
});
