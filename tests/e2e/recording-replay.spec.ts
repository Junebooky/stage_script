import { test, expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Show } from "../../packages/script-schema/src/index";
import type { RecordingReplayProfile, RecordingReference } from "../../packages/rehearsal/src/recording-profile";
const rawShow = JSON.parse(readFileSync("data/productions/decadence-gyeongseong/numbers/M05-2.json", "utf8")) as Show;
const rawProfile = JSON.parse(readFileSync("data/replay-recordings/R001-M05-2.profile.json", "utf8")) as RecordingReplayProfile;
const rawReference = JSON.parse(readFileSync("data/replay-recordings/R001-M05-2.reference.json", "utf8")) as RecordingReference;

// Sixteen seconds of synthetic silence + explicitly synthetic saved ASR.
// This covers browser wiring, NOT the real recording's ASR accuracy/latency.
// Space fixture cues 500ms apart so every canonical frame has a painting window;
// deliberate clock-stall/coalescing is separately covered by domain diagnostics.
const canonical = rawShow.acts.flatMap((act) => act.numbers.flatMap((number) => number.cues));
const performed = canonical.filter((cue) => rawProfile.performedCueIds.includes(cue.id));
const wav = Buffer.alloc(44 + 16000 * 2 * 16);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
const audioSha = createHash("sha256").update(wav).digest("hex");
const transcript = performed.map((cue, index) => ({ id: `synthetic-${index}`, text: cue.matchText.join(" "), startMs: 1000 + index * 500, endMs: 1100 + index * 500, confidence: null,
  words: [{ text: cue.matchText.join(" "), startMs: 1000 + index * 500, endMs: 1100 + index * 500, confidence: null, confidenceBasis: "unavailable" }] }));
transcript.push({ id: "synthetic-post-take", text: "감사합니다.", startMs: 15000, endMs: 15200, confidence: null,
  words: [{ text: "감사합니다.", startMs: 15000, endMs: 15200, confidence: null, confidenceBasis: "unavailable" }] });
const data = { profile: { ...rawProfile, sourceAudioSha256: audioSha, nonCanonicalEvents: [{ ...rawProfile.nonCanonicalEvents[0], startMs: 15000, endMs: 15200 }] },
  reference: { ...rawReference, provenance: "Synthetic browser test; not real recording evidence", cues: rawReference.cues.map((cue, index) => ({ ...cue, referenceStartMs: 1000 + index * 500 })) },
  evidence: { version: 1, recordingId: rawProfile.recordingId, sourceAudioSha256: audioSha, sourceArtifactSha256: rawProfile.asrEvidenceSource.sha256,
    runId: "synthetic-browser-fixture", provider: "synthetic-test", model: "none", deliveryBasis: "saved-word-end-simulation", liveLatencyMeasured: false,
    wordConfidence: "unavailable", sourceSegmentCount: transcript.length, sourceWordCount: transcript.length,
    derivation: "Synthetic fixture only", warnings: [], transcript }, durationMs: 16000, audioBytes: wav.length };

async function routes(page: Page, missing = false) {
  await page.route("http://localhost:8000/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/profiles") return route.fulfill({ json: { champion: null, challengers: [] } });
    if (path === "/rehearsals") return route.fulfill({ json: [] });
    if (path === "/replay-recordings/R001-M05-2") return route.fulfill({ status: missing ? 409 : 200, json: missing ? { detail: "Registered local replay file missing. No ASR request was made." } : data });
    if (path === "/replay-recordings/R001-M05-2/audio") return route.fulfill({ contentType: "audio/wav", body: wav });
    throw new Error(`Unexpected request in saved replay: ${route.request().method()} ${path}`);
  });
}
async function prepare(page: Page) {
  await routes(page);
  await page.goto("/rehearsal");
  await page.getByRole("button", { name: "R001 리플레이 준비" }).click();
  await expect(page.getByRole("button", { name: "START REPLAY", exact: true })).toBeEnabled();
}
const audioState = (page: Page) => page.locator("audio[aria-label='Registered replay original audio']").evaluate((audio: HTMLAudioElement) => ({ time: audio.currentTime, rate: audio.playbackRate, paused: audio.paused }));

test("synthetic original-audio clock → unchanged engine → 27 canonical audience cues, not reference dispatch", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await prepare(page);
  const audience = await context.newPage();
  await audience.goto("/output");
  await audience.evaluate(() => {
    const scope = window as unknown as { replayFrames: unknown[]; replayChannel: BroadcastChannel };
    scope.replayFrames = [];
    scope.replayChannel = new BroadcastChannel("cueflow-local-output-v1");
    scope.replayChannel.onmessage = ({ data }) => { if (data.type === "state") scope.replayFrames.push(data.view); };
  });
  await page.bringToFront();
  const started = Date.now();
  await page.getByRole("button", { name: "START REPLAY", exact: true }).click();
  await expect(page.locator(".recording-replay")).toHaveAttribute("data-replay-state", "playing");
  await expect(page.getByTestId("replay-current-cue")).toHaveText("M05-2_C036", { timeout: 20000 });
  await expect(page.locator(".recording-replay")).toHaveAttribute("data-replay-state", "ended", { timeout: 15000 });
  expect(Date.now() - started).toBeGreaterThan(15500);
  expect((await audioState(page)).rate).toBe(1);
  await expect(page.getByTestId("replay-summary")).toContainText("27 / 27 correct");
  await expect(page.getByTestId("replay-summary")).toContainText("0 missed");
  await expect(page.getByTestId("replay-post-take")).toContainText("오송출 0");
  await expect(audience.getByRole("main")).toContainText(performed.at(-1)!.captions[0]!.text);
  const frames = await audience.evaluate(() => (window as unknown as { replayFrames: { kind: string; cueId?: string; lines?: string[] }[] }).replayFrames);
  const ids = [...new Set(frames.flatMap((frame) => frame.kind === "caption" ? [frame.cueId] : []))];
  expect(ids).toEqual(rawProfile.performedCueIds);
  for (const frame of frames.filter((item) => item.kind === "caption")) expect(frame.lines).toEqual(canonical.find((cue) => cue.id === frame.cueId)!.captions.map((line) => line.text));
  expect(frames.some((frame) => frame.cueId && rawProfile.absentCueIds.includes(frame.cueId))).toBe(false);
  expect(errors).toEqual([]);
});

test("pause/resume, stop-to-black, restart reset, and explicit manual authority", async ({ page, context }) => {
  await prepare(page);
  const audience = await context.newPage(); await audience.goto("/output"); await page.bringToFront();
  await page.getByRole("button", { name: "START REPLAY", exact: true }).click();
  await expect(page.getByTestId("replay-current-cue")).not.toHaveText("—");
  await page.getByRole("button", { name: "PAUSE", exact: true }).click();
  const paused = await audioState(page);
  const summary = await page.getByTestId("replay-summary").innerText();
  await page.waitForTimeout(300);
  expect(await audioState(page)).toEqual(paused);
  expect(await page.getByTestId("replay-summary").innerText()).toBe(summary);
  await page.getByRole("button", { name: "RESUME", exact: true }).click();
  await expect.poll(async () => (await audioState(page)).time).toBeGreaterThan(paused.time);
  await page.getByRole("button", { name: "STOP", exact: true }).click();
  await expect(page.getByTestId("replay-current-cue")).toHaveText("—");
  await expect(audience.getByRole("main")).toHaveAttribute("data-kind", "black");
  await page.getByRole("button", { name: "RESTART", exact: true }).click();
  expect((await audioState(page)).time).toBeLessThan(1);
  await expect(page.getByTestId("replay-summary")).toContainText("0 / 27 correct");
  await page.getByRole("button", { name: "PAUSE", exact: true }).click();
  await page.getByRole("button", { name: "다음 큐 송출", exact: true }).click();
  await expect(page.getByTestId("replay-current-cue")).toHaveText("M05-2_C001");
  await expect(page.locator(".replay-evidence")).toContainText("manual");
});

test("missing local evidence is explicit; no automatic provider or upload fallback", async ({ page }) => {
  await routes(page, true);
  const writes: string[] = [];
  page.on("request", (request) => { if (request.method() !== "GET") writes.push(request.method()); });
  await page.goto("/rehearsal"); await page.getByRole("button", { name: "R001 리플레이 준비" }).click();
  await expect(page.getByRole("region", { name: "Realtime recording replay" }).getByRole("alert")).toContainText("No ASR request was made");
  await expect(page.getByRole("button", { name: "START REPLAY", exact: true })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test("replay cannot acquire a second authoritative operator lock", async ({ page, context }) => {
  const first = await context.newPage(); await first.goto("/output");
  await first.evaluate(() => { void navigator.locks.request("cueflow-authoritative-operator-v1", () => new Promise(() => {})); });
  await routes(page); await page.goto("/rehearsal"); await page.getByRole("button", { name: "R001 리플레이 준비" }).click();
  await expect(page.getByRole("region", { name: "Realtime recording replay" }).getByRole("alert")).toContainText("다른 운영 창");
  await expect(page.getByRole("button", { name: "START REPLAY", exact: true })).toBeDisabled();
});
