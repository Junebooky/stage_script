import { test, expect, type Page } from "@playwright/test";

// Synthetic silence with the R001 duration: validates media/seek/publisher wiring,
// never a claim about acoustic ASR or real reference accuracy.
const wav = Buffer.alloc(44 + Math.round(226.138479 * 8000));
wav.fill(128, 44);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(8000, 28); wav.writeUInt16LE(1, 32); wav.writeUInt16LE(8, 34);
wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);

async function prepare(page: Page) {
  await page.route("**/*.wav", (route) => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? "");
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
    return route.fulfill({ status: range ? 206 : 200, contentType: "audio/wav", body: wav.subarray(start, end + 1),
      headers: { "accept-ranges": "bytes", "content-length": String(end - start + 1), ...(range ? { "content-range": `bytes ${start}-${end}/${wav.length}` } : {}) } });
  });
  await page.goto("/operator");
  await expect(page.getByRole("slider", { name: "음원 탐색" })).toBeEnabled();
}
async function seek(page: Page, seconds: number) {
  await page.getByRole("slider", { name: "음원 탐색" }).fill(String(seconds));
}

test("track demo plays, pauses, seeks both ways, resyncs and sends canonical audience frames", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await prepare(page);
  await expect(page.locator(".engineering-settings")).not.toHaveAttribute("open", "");
  const audience = await context.newPage();
  await audience.goto("/output");
  const output = audience.getByRole("main");
  await page.getByRole("button", { name: "재생 시작", exact: true }).click();
  await expect(page.getByLabel("음원 시연 콘솔")).toHaveAttribute("data-demo-state", "playing");
  await seek(page, 8.5);
  await expect(output).toHaveAttribute("data-cue", "M05-2_C001");
  await expect(output).toHaveText("창가로 스며드는 외로운 저 달빛");
  await seek(page, 16.3);
  await expect(output).toHaveAttribute("data-cue", "M05-2_C002"); // crosses boundary by playback, not another seek
  await page.getByRole("button", { name: "일시정지", exact: true }).click();
  const paused = await page.locator("audio").evaluate((audio: HTMLAudioElement) => ({ time: audio.currentTime, paused: audio.paused, muted: audio.muted, rate: audio.playbackRate }));
  expect(paused).toMatchObject({ paused: true, muted: false, rate: 1 });
  await expect.poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.currentTime)).toBe(paused.time);
  await seek(page, 79);
  await expect(output).toHaveAttribute("data-cue", "M05-2_C018");
  await seek(page, 9);
  await expect(output).toHaveAttribute("data-cue", "M05-2_C001");
  await page.getByRole("heading", { name: "데카당스 경성" }).click();
  await page.keyboard.press("Space");
  await expect(output).toHaveAttribute("data-cue", "M05-2_C002");
  await page.keyboard.press("r");
  await expect(output).toHaveAttribute("data-cue", "M05-2_C001");
  await seek(page, 0);
  await expect(output).toHaveAttribute("data-kind", "black");
  await expect(page.getByTestId("demo-timecode")).toContainText("00:00.00 / 03:46.13");
  await seek(page, 226);
  await page.getByRole("button", { name: "재생 계속", exact: true }).click();
  await expect(page.getByLabel("음원 시연 콘솔")).toHaveAttribute("data-demo-state", "ended");
  await expect(output).toHaveAttribute("data-cue", "M05-2_C036");
  await page.getByRole("button", { name: "정지", exact: true }).click();
  await expect(page.getByLabel("음원 시연 콘솔")).toHaveAttribute("data-demo-state", "ready");
  expect(errors).toEqual([]);
});

test("mode switch stops audio, local file URLs stay client-side, duplicate operator cannot play", async ({ page, context }) => {
  await prepare(page);
  await page.getByLabel("시연 음원 파일 선택").setInputFiles({ name: "R001-fixture.wav", mimeType: "audio/wav", buffer: wav });
  await expect(page.getByRole("slider", { name: "음원 탐색" })).toBeEnabled();
  await page.getByRole("button", { name: "재생 시작", exact: true }).click();
  await page.locator("audio").evaluate((audio) => { Object.assign(window, { previousDemoAudio: audio }); });
  const second = await context.newPage();
  await second.goto("/operator");
  await expect(second.getByRole("button", { name: "재생 시작", exact: true })).toBeDisabled();
  await second.close();
  await page.getByRole("button", { name: "🎙️ 라이브 마이크 모드" }).click();
  expect(await page.evaluate(() => (window as unknown as { previousDemoAudio: HTMLAudioElement }).previousDemoAudio.paused)).toBe(true);
  await expect(page.locator("audio")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start microphone", exact: true })).toBeEnabled();
  await expect(page.getByLabel("Performance ASR source")).not.toBeVisible();
  await page.getByRole("button", { name: "🎵 음원 시연 모드" }).click();
  await expect(page.getByRole("button", { name: "재생 시작", exact: true })).toBeEnabled();
});

test("single mic button starts after readiness, mode switch aborts recognition and releases media", async ({ page, context }) => {
  await context.grantPermissions(["microphone"]);
  await page.addInitScript(() => {
    const streams: MediaStream[] = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => { const stream = await original(constraints); streams.push(stream); return stream; };
    class Speech {
      onstart?: () => void; onend?: () => void; onresult?: (event: unknown) => void;
      start() { Object.assign(window, { demoRecognition: this }); queueMicrotask(() => this.onstart?.()); }
      abort() { this.onend?.(); }
      stop() { this.onend?.(); }
    }
    Object.assign(window, { SpeechRecognition: Speech, demoStreams: streams });
  });
  await prepare(page);
  await page.getByRole("button", { name: "🎙️ 라이브 마이크 모드" }).click();
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await expect(page.getByLabel("Show lifecycle")).toHaveAttribute("data-show-state", "ACT_ARMED");
  const audience = await context.newPage();
  await audience.goto("/output");
  await expect(page.getByLabel("Show lifecycle")).toHaveAttribute("data-show-state", "ACT_LIVE");
  await page.evaluate(() => {
    (window as unknown as { demoRecognition: { onresult: (event: unknown) => void } }).demoRecognition.onresult({ resultIndex: 0, results: { length: 1, 0: { isFinal: false, length: 1, 0: { transcript: "창가로 스며드는", confidence: .99 } } } });
  });
  await expect(audience.getByRole("main")).toHaveAttribute("data-cue", "M05-2_C001");
  await expect(page.getByLabel("Recognized speech")).toHaveText("창가로 스며드는");
  await page.getByRole("button", { name: "🎵 음원 시연 모드" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { demoStreams: MediaStream[] }).demoStreams.every((stream) => stream.getTracks().every((track) => track.readyState === "ended")))).toBe(true);
  await expect(audience.getByRole("main")).toHaveAttribute("data-kind", "black");
  await page.evaluate(() => {
    (window as unknown as { demoRecognition: { onresult?: (event: unknown) => void } }).demoRecognition.onresult?.({ resultIndex: 0, results: { length: 1, 0: { isFinal: true, length: 1, 0: { transcript: "달빛은 떨리는 내 손을 잡아", confidence: .99 } } } });
  });
  await expect(audience.getByRole("main")).toHaveAttribute("data-kind", "black");
});
