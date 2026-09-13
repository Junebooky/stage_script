import { test, expect } from "@playwright/test";
import type { ProfileCandidate, RehearsalAnalysis } from "@stage/rehearsal";

for (const provider of ["local", "groq"] as const) test(`${provider}: raw audio leads to separate observations, human review and a non-promoted challenger`, async ({ page, context }) => {
  const canonical = { id: "rehearsal-browser-test", title: "리허설 검증 공연", locale: "ko-KR", acts: [
    { id: "act-1", title: "1막", numbers: [{ id: "m01", title: "첫 노래", cues: [
      { id: "one", type: "CAPTION", order: 1, captions: [{ actor: "A", text: "가장 어려운 곳에 주님의 사랑이" }], matchText: ["가장 어려운 곳에 주님의 사랑이"] },
      { id: "two", type: "CAPTION", order: 2, captions: [{ actor: "B", text: "우리의 노래는 하늘을 향해" }], matchText: ["우리의 노래는 하늘을 향해"] }
    ] }] }
  ] };
  await context.addInitScript((show) => localStorage.setItem("cueflow-canonical-show-v1", JSON.stringify(show)), canonical);
  let uploaded = false;
  let rawBytes = 0;
  let analysis: RehearsalAnalysis | null = null;
  let candidate: ProfileCandidate | null = null;
  let promotions = 0;
  const model = provider === "groq" ? "whisper-large-v3" : "local-test-fixture";
  const evidence = provider === "groq" ? { confidence: null, confidenceBasis: "unavailable" } : { confidence: 0.99, confidenceBasis: "provider-native" };
  const manifest = { id: "recording-one", filename: "whole-show.wav", showId: canonical.id, status: "complete", durationMs: 7000, asrProvider: provider, model };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!["localhost", "127.0.0.1"].includes(url.hostname)) return route.abort();
    if (url.port !== "8000") return route.continue();
    const headers = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,PUT,OPTIONS", "access-control-allow-headers": "content-type" };
    const reply = (json: unknown, status = 200) => route.fulfill({ status, headers, json });
    if (request.method() === "OPTIONS") return reply({});
    if (url.pathname === "/rehearsals" && request.method() === "POST") {
      rawBytes = request.postDataBuffer()?.length ?? 0;
      expect(url.searchParams.get("showId")).toBe(canonical.id);
      expect(url.searchParams.get("filename")).toBe("whole-show.wav");
      expect(url.searchParams.get("provider")).toBe(provider);
      expect(url.searchParams.get("allowCloudUpload")).toBe(String(provider === "groq"));
      uploaded = true;
      return reply({ ...manifest, status: "queued" }, 202);
    }
    if (url.pathname === "/rehearsals") return reply(uploaded ? [manifest] : []);
    if (url.pathname.endsWith("/analysis")) {
      if (request.method() === "PUT") { analysis = request.postDataJSON(); return reply({ saved: true }); }
      return analysis ? reply(analysis) : reply({ detail: "Not analyzed" }, 404);
    }
    if (url.pathname.endsWith("/result")) return reply({ manifest, asrProvider: provider, model, timestampBasis: provider === "groq" ? "cloud-asr-pseudo" : "local-asr-pseudo", transcript: [
      { id: "s1", text: "어려운 곳에 주님의 사랑이", startMs: 1000, endMs: 2500, ...evidence },
      { id: "s2", text: "우리의 노래는 하늘을 향해", startMs: 5000, endMs: 6500, ...evidence }
    ] });
    if (url.pathname.endsWith("/audio")) return route.fulfill({ headers, contentType: "audio/wav", body: wav });
    if (url.pathname === "/profiles") return reply({ champion: null, challengers: candidate ? [candidate] : [] });
    if (url.pathname === "/profiles/challengers") {
      candidate = { ...request.postDataJSON(), id: "candidate-one", createdAt: new Date().toISOString(), promoted: false };
      return reply(candidate, 201);
    }
    if (url.pathname.endsWith("/promote")) { promotions++; return reply({ detail: "Must not promote" }, 409); }
    return reply({ detail: `Unexpected endpoint ${url.pathname}` }, 404);
  });
  // The server's acoustic model is deliberately stubbed; the web alignment,
  // review, profile generation and regression code are the real implementations.
  const wav = Buffer.alloc(44 + 3200);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(3200, 40);
  await page.goto("/rehearsal");
  await page.getByLabel("Rehearsal ASR provider").selectOption(provider);
  if (provider === "groq") await page.getByLabel("Allow external audio upload").check();
  await expect(page.getByText(canonical.title, { exact: false })).toBeVisible();
  await page.getByLabel("Upload rehearsal audio").setInputFiles({ name: "whole-show.wav", mimeType: "audio/wav", buffer: wav });
  await expect(page.locator(".analysis-summary")).toContainText("2 cues");
  expect(rawBytes).toBe(wav.length);
  expect(analysis!.observations.every((observation) => observation.groundTruth === "pseudo")).toBe(true);
  expect(analysis!.asrProvider).toBe(provider);
  expect(analysis!.model).toBe(model);
  if (provider === "groq") {
    expect(analysis!.observations.every((observation) => observation.asrConfidence === null
      && observation.alignmentEvidenceBasis === "text-sequence-only")).toBe(true);
    await expect(page.getByText("ASR: groq / whisper-large-v3", { exact: false })).toBeVisible();
  }
  await page.getByLabel("Reviewer name").fill("테스트 검토자");
  const observation = page.locator(".observation").first();
  await observation.locator("summary").click();
  await expect(observation).toContainText("가장 어려운 곳에 주님의 사랑이");
  await expect(observation).toContainText("ASR: 어려운 곳에 주님의 사랑이");
  await observation.getByLabel("시작(초)").fill("0.9");
  await observation.getByRole("button", { name: "직접 확인한 시각 저장" }).click();
  await expect(page.locator(".observation").first()).toContainText("HUMAN CONFIRMED");
  expect(analysis!.observations[0]!.startMs).toBe(900);
  await page.getByRole("button", { name: "전체 이력 재생 → 후보 프로필 생성" }).click();
  await expect(page.getByLabel("Challenger evaluation")).toContainText("승격 보류");
  expect(candidate!.evaluation.recommended).toBe(false);
  expect(candidate!.evaluation.replays).toHaveLength(1);
  expect(candidate!.profiles.every((profile) => !profile.fallback.enabled)).toBe(true);
  await page.getByLabel("Promotion operator").fill("테스트 승인자");
  await page.getByRole("checkbox", { name: "전체 이력과 검토 결과를 확인했으며 이 후보의 승격을 승인합니다." }).check();
  await expect(page.getByRole("button", { name: "승인 후 Champion으로 승격" })).toBeDisabled();
  expect(promotions).toBe(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("cueflow-canonical-show-v1")!))).toEqual(canonical);
  await page.screenshot({ path: "/tmp/stage-rehearsal-review.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await expect(page.getByLabel("Upload rehearsal audio")).toBeInViewport({ ratio: 1 });
});
