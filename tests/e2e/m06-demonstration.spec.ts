import { test, expect } from "@playwright/test";
import reference from "../../data/replay-recordings/R001-M06.reference.json" with { type: "json" };
import canonical from "../../data/productions/decadence-gyeongseong/numbers/M06.json" with { type: "json" };

test("M06 registered timeline sends all 26 canonical cues and releases old media on number switch", async ({ page, context }) => {
  // Synthetic media validates scheduler wiring, not acoustic alignment quality.
  const wav = Buffer.alloc(44 + 136 * 8000, 128);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
  wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
  await page.route("**/replay-recordings/R001-M06/audio", (route) => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: "audio/wav", body: wav.subarray(start, end + 1),
      headers: { "accept-ranges": "bytes", "content-length": String(end - start + 1), ...(range ? { "content-range": `bytes ${start}-${end}/${wav.length}` } : {}) } });
  });
  await page.goto("/operator");
  await page.getByLabel("시연 넘버", { exact: true }).selectOption("R001-M06");
  const slider = page.getByRole("slider", { name: "음원 탐색" });
  await expect(slider).toBeEnabled();
  const audience = await context.newPage(); await audience.goto("/output");
  for (const cue of reference.cues) {
    await slider.fill(String(Number((cue.referenceStartMs / 1000 + .1).toFixed(2))));
    await expect(audience.getByRole("main")).toHaveAttribute("data-cue", cue.cueId);
    const text = canonical.acts[0]!.numbers[0]!.cues.find((item) => item.id === cue.cueId)!.captions.map((line) => line.text).join("");
    await expect(audience.getByRole("main")).toHaveText(text);
  }
  await page.getByRole("button", { name: "재생 계속", exact: true }).click();
  await page.locator("audio").evaluate((audio) => Object.assign(window, { oldM06Audio: audio }));
  await page.getByLabel("시연 넘버", { exact: true }).selectOption("R001-M05-2");
  expect(await page.evaluate(() => (window as unknown as { oldM06Audio: HTMLAudioElement }).oldM06Audio.paused)).toBe(true);
  await expect(audience.getByRole("main")).toHaveAttribute("data-kind", "black");
});

test("real M06 WAV plays full 136 seconds at 1x without manual cues", async ({ page, context }) => {
  test.skip(process.env.M06_REAL_AUDIO !== "1", "Requires registered private WAV and localhost audio backend");
  test.setTimeout(160000);
  await page.goto("/operator");
  await page.getByLabel("시연 넘버", { exact: true }).selectOption("R001-M06");
  await expect(page.getByRole("slider", { name: "음원 탐색" })).toBeEnabled();
  const audience = await context.newPage(); await audience.goto("/output");
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.evaluate(() => {
    const events: { cueId: string; time: number }[] = [];
    Object.assign(window, { m06Events: events });
    new MutationObserver(() => {
      const cueId = document.querySelector(".output-footer span")?.textContent ?? "";
      if (cueId.startsWith("M06_C") && events.at(-1)?.cueId !== cueId) events.push({ cueId, time: document.querySelector("audio")!.currentTime });
    }).observe(document.querySelector(".demo-track-stage")!, { subtree: true, childList: true, characterData: true });
  });
  await page.getByRole("button", { name: "재생 시작", exact: true }).click();
  await expect(page.getByLabel("음원 시연 콘솔")).toHaveAttribute("data-demo-state", "ended", { timeout: 145000 });
  const events = await page.evaluate(() => (window as unknown as { m06Events: { cueId: string; time: number }[] }).m06Events);
  expect(events.map((event) => event.cueId)).toEqual(reference.cues.map((cue) => cue.cueId));
  await expect(audience.getByRole("main")).toHaveAttribute("data-cue", "M06_C026");
  expect(await page.locator("audio").evaluate((audio: HTMLAudioElement) => ({ duration: audio.duration, rate: audio.playbackRate, muted: audio.muted }))).toEqual({ duration: 136, rate: 1, muted: false });
  expect(errors).toEqual([]);
  const schedulingErrors = events.map((event, i) => event.time * 1000 - reference.cues[i]!.referenceStartMs);
  console.log(JSON.stringify({ actualWav: true, cues: events.length, manualCues: 0, maxSchedulingErrorMs: Math.max(...schedulingErrors), minSchedulingErrorMs: Math.min(...schedulingErrors), note: "Media scheduling error, NOT acoustic accuracy or live ASR latency" }));
});
