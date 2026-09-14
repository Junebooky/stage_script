/** Opt-in real elapsed browser validation. Requires both local servers and the
 * registered PRIVATE R001 WAV/ASR artifacts. Never calls or mocks an ASR service. */
import { chromium, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";

const root = process.cwd();
const profile = JSON.parse(await readFile("data/replay-recordings/R001-M05-2.profile.json", "utf8"));
const canonical = JSON.parse(await readFile("data/productions/decadence-gyeongseong/numbers/M05-2.json", "utf8"));
const cues = canonical.acts.flatMap((act) => act.numbers.flatMap((number) => number.cues));
const digest = async (path) => createHash("sha256").update(await readFile(path)).digest("hex");
const before = await digest(profile.sourceAudioPath);
expect(before).toBe(profile.sourceAudioSha256);
const output = resolve(root, ".stage-data/replay-evaluations", `browser-${randomUUID()}`);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: process.env.REPLAY_HEADED !== "1" });
const context = await browser.newContext({ baseURL: "http://localhost:3000", viewport: { width: 1440, height: 1050 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [], requests = [], samples = [];
let progress;
try {
  // Fail closed before a non-loopback request, including an accidental provider call.
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!["localhost", "127.0.0.1"].includes(url.hostname) || route.request().method() !== "GET") {
      errors.push(`Blocked non-replay request: ${route.request().method()} ${url.origin}${url.pathname}`);
      return route.abort();
    }
    requests.push({ method: "GET", origin: url.origin, path: url.pathname });
    await route.continue();
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/rehearsal");
  await page.getByRole("button", { name: "R001 리플레이 준비" }).click();
  await expect(page.getByRole("button", { name: "START REPLAY", exact: true })).toBeEnabled();
  const audio = page.locator("audio[aria-label='Registered replay original audio']");
  const readAudio = () => audio.evaluate((element) => ({ time: element.currentTime, duration: element.duration, rate: element.playbackRate, paused: element.paused, ended: element.ended }));
  await page.getByRole("button", { name: "START REPLAY", exact: true }).click();
  await expect.poll(async () => (await readAudio()).time).toBeGreaterThan(1);
  await page.getByRole("button", { name: "PAUSE", exact: true }).click();
  const paused = await readAudio();
  const pausedSummary = await page.getByTestId("replay-summary").innerText();
  await page.waitForTimeout(500);
  expect(await readAudio()).toEqual(paused);
  expect(await page.getByTestId("replay-summary").innerText()).toBe(pausedSummary);
  await page.getByRole("button", { name: "RESUME", exact: true }).click();
  await expect.poll(async () => (await readAudio()).time).toBeGreaterThan(paused.time + 0.25);
  await page.getByRole("button", { name: "STOP", exact: true }).click();
  await expect(page.getByTestId("replay-current-cue")).toHaveText("—");

  const audience = await context.newPage();
  audience.on("pageerror", (error) => errors.push(error.message));
  await audience.goto("/output");
  await audience.evaluate(() => {
    window.replayRendered = [];
    const main = document.querySelector("main");
    let last = null;
    const observer = new MutationObserver(() => {
      const cueId = main.dataset.cue;
      if (main.dataset.kind === "caption" && cueId !== last) {
        window.replayRendered.push({ cueId, lines: Array.from(main.querySelectorAll("p")).map((line) => line.textContent), wallAt: Date.now() });
        last = cueId;
      }
    });
    observer.observe(main, { childList: true, subtree: true, attributes: true });
  });
  await page.bringToFront();
  const began = Date.now();
  await page.getByRole("button", { name: "RESTART", exact: true }).click();
  expect((await readAudio()).time).toBeLessThan(1);
  await expect(page.getByTestId("replay-summary")).toContainText("0 / 27 correct");
  let polling = false;
  progress = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const audioState = await readAudio();
      const cueId = await page.getByTestId("replay-current-cue").innerText();
      samples.push({ wallElapsedMs: Date.now() - began, ...audioState, cueId });
      console.log(`Real elapsed replay: ${audioState.time.toFixed(1)} / ${audioState.duration.toFixed(1)}s · ${cueId} · ${audioState.rate}x`);
    } catch { /* main test owns lifecycle/error reporting */ }
    finally { polling = false; }
  }, 20000);
  // Intentionally focus audience during the transition and repeated opening.
  await expect.poll(async () => (await readAudio()).time, { timeout: 35000 }).toBeGreaterThan(25);
  await audience.bringToFront();
  await expect.poll(async () => (await readAudio()).time, { timeout: 70000 }).toBeGreaterThan(85);
  await audience.screenshot({ path: resolve(output, "audience-repeated-opening.png") });
  await page.bringToFront();
  await expect(page.locator(".recording-replay")).toHaveAttribute("data-replay-state", "ended", { timeout: 180000 });
  clearInterval(progress);
  const elapsedMs = Date.now() - began;
  const finalAudio = await readAudio();
  expect(finalAudio.ended).toBe(true); expect(finalAudio.rate).toBe(1);
  expect(elapsedMs).toBeGreaterThan(225000);
  await page.locator(".replay-evaluation summary").click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "로컬 평가 JSON 저장" }).click();
  await (await downloaded).saveAs(resolve(output, "evaluation.json"));
  const report = JSON.parse(await readFile(resolve(output, "evaluation.json"), "utf8"));
  const rendered = await audience.evaluate(() => window.replayRendered);
  const after = await digest(profile.sourceAudioPath);
  await page.locator(".replay-controls").first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(output, "operator-complete.png"), fullPage: true });
  await audience.screenshot({ path: resolve(output, "audience-complete.png") });
  const validation = { mode: "real-elapsed-original-WAV-browser-audio-clock", headless: process.env.REPLAY_HEADED !== "1", elapsedMs,
    audio: finalAudio, originalSha256Before: before, originalSha256After: after, originalUnchanged: before === after,
    lifecycle: { pauseFrozen: true, resumeAdvanced: true, stopBlack: true, restartReset: true },
    backgroundOperatorWindow: { fromSeconds: 25, toSeconds: 85 }, requests, errors, samples, rendered, metrics: report.metrics };
  await writeFile(resolve(output, "browser-validation.json"), JSON.stringify(validation, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ output, elapsedMs, renderedCueCount: rendered.length, ...report.metrics, errors }, null, 2));
  expect(after).toBe(before);
  expect(report.metrics.correctTriggerCount).toBe(27); expect(report.metrics.missedCueCount).toBe(0);
  expect(report.metrics.wrongTriggerCount).toBe(0); expect(report.metrics.postTakeFalseTriggerCount).toBe(0);
  expect(report.metrics.fallbackTriggerCount).toBe(0); expect(report.metrics.manualTriggerCount).toBe(0);
  expect(report.metrics.repeatedLyricConfusionCount).toBe(0); expect(report.metrics.unexpectedReplaySkipCount).toBe(0);
  expect(report.metrics.maxEvidenceDispatchLagMs).toBeLessThan(1000);
  expect(rendered.map((item) => item.cueId)).toEqual(profile.performedCueIds);
  for (const item of rendered) expect(item.lines).toEqual(cues.find((cue) => cue.id === item.cueId).captions.map((line) => line.text));
  expect(errors).toEqual([]);
  await page.getByRole("button", { name: "STOP", exact: true }).click();
  await expect(audience.getByRole("main")).toHaveAttribute("data-kind", "black");
} finally {
  if (progress) clearInterval(progress);
  await context.close();
  await browser.close();
}
