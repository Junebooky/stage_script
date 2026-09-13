import { expect, test, type Page } from "@playwright/test";

// Deliberately synthetic operator frames exercise the actual read-only audience
// route and BroadcastChannel. No microphone or ASR service is used here.
const channelName = "cueflow-local-output-v1";
const localImage = "/bg_image/decadence_gyeongseong_m07_night_stage_01.jpg";
const caption = { kind: "caption", cueId: "synthetic-cue", lines: ["확정된 공연 대본", "관객에게 보이는 두 번째 줄"] };

async function syntheticOperator(page: Page) {
  await page.goto("/output");
  await page.evaluate((name) => {
    const channel = new BroadcastChannel(name);
    const fixture = { channel, sequence: 0, epoch: 100, session: "synthetic-operator", view: { kind: "black" } as unknown, messages: [] as unknown[] };
    channel.onmessage = ({ data }) => {
      fixture.messages.push(data);
      if (data?.type === "hello") channel.postMessage({ type: "state", version: 1, session: fixture.session, epoch: fixture.epoch, sequence: ++fixture.sequence, view: fixture.view });
    };
    Object.assign(window, { audienceFixture: fixture });
  }, channelName);
}

async function send(page: Page, view: unknown, overrides: Record<string, unknown> = {}) {
  await page.evaluate(({ view, overrides }) => {
    const fixture = (window as unknown as { audienceFixture: { channel: BroadcastChannel; sequence: number; epoch: number; session: string; view: unknown } }).audienceFixture;
    fixture.view = view;
    fixture.channel.postMessage({ type: "state", version: 1, session: fixture.session, epoch: fixture.epoch, sequence: ++fixture.sequence, view, ...overrides });
  }, { view, overrides });
}

test("audience stays read-only, orders snapshots, retains output during a disconnect and reconnects", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await syntheticOperator(page);
  const screen = await context.newPage();
  await screen.goto("/output");
  const output = screen.getByRole("main", { name: "Audience caption output" });
  await expect(output).toHaveAttribute("data-kind", "black");
  await send(page, { ...caption, heardText: "노출되면 안 되는 인식문", operatorControls: true });
  await expect(output).toHaveText(caption.lines.join(""));
  await expect(output).toHaveAttribute("data-connection", "live");
  await expect(screen.getByRole("button")).toHaveCount(0);
  await expect(screen.locator("input, select, audio, canvas")).toHaveCount(0);
  await send(page, { kind: "caption", cueId: "obsolete", lines: ["오래된 자막"] }, { sequence: 0 });
  await expect(output).toHaveText(caption.lines.join(""));
  await page.evaluate(() => {
    const fixture = (window as unknown as { audienceFixture: { channel: BroadcastChannel } }).audienceFixture;
    fixture.channel.onmessage = null;
  });
  await expect(output).toHaveAttribute("data-connection", "held", { timeout: 5000 });
  await expect(output).toHaveText(caption.lines.join(""));
  await send(page, { kind: "caption", cueId: "reconnected", lines: ["다시 연결된 확정 자막"] });
  await expect(output).toHaveAttribute("data-connection", "live");
  await expect(output).toHaveText("다시 연결된 확정 자막");
  expect(errors).toEqual([]);
});

test("late joining and reloaded audience windows receive the current canonical snapshot", async ({ page, context }) => {
  await syntheticOperator(page);
  await send(page, caption);
  const screen = await context.newPage();
  await screen.goto("/output");
  await expect(screen.getByRole("main")).toHaveText(caption.lines.join(""));
  await screen.reload();
  await expect(screen.getByRole("main")).toHaveText(caption.lines.join(""));
  const messages = await page.evaluate(() => (window as unknown as { audienceFixture: { messages: Array<{ type: string }> } }).audienceFixture.messages);
  expect(messages.filter((message) => message.type === "hello").length).toBeGreaterThanOrEqual(2);
  expect(messages.some((message) => message.type === "ack")).toBe(true);
});

test("explicit local images render without internet and errors never display their alt text", async ({ page, context }) => {
  const externalRequests: string[] = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") { externalRequests.push(url.href); return route.abort(); }
    return route.continue();
  });
  await syntheticOperator(page);
  const screen = await context.newPage();
  await screen.goto("/output");
  await send(page, { kind: "image", cueId: "explicit-image", src: localImage, alt: "공연 배경" });
  await expect(screen.getByRole("img", { name: "공연 배경" })).toBeVisible();
  await expect(screen.getByRole("main")).toHaveText("");
  await send(page, { kind: "image", cueId: "missing-image", src: "/bg_image/missing.jpg", alt: "실패하면 보여서는 안 되는 원문" });
  await expect(screen.getByRole("main")).toHaveAttribute("data-cue", "missing-image");
  await expect(screen.getByRole("img")).toHaveCount(0);
  await expect(screen.getByRole("main")).toHaveText("");
  await send(page, { kind: "image", cueId: "remote-image", src: "https://example.invalid/show.jpg", alt: "외부 이미지" });
  await expect(screen.getByRole("main")).toHaveAttribute("data-cue", "missing-image");
  await send(page, caption);
  await expect(screen.getByRole("main")).toHaveText(caption.lines.join(""));
  expect(externalRequests).toEqual([]);
});

test("a delayed previous image cannot acknowledge a new cue as ready", async ({ page, context }) => {
  let releaseImage: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { releaseImage = resolve; });
  await context.route(`**${localImage}`, async (route) => { await blocked; await route.continue().catch(() => {}); });
  await syntheticOperator(page);
  const screen = await context.newPage();
  await screen.goto("/output");
  await send(page, { kind: "image", cueId: "slow-image", src: localImage, alt: "지연 이미지" });
  await expect(screen.getByRole("main")).toHaveAttribute("data-cue", "slow-image");
  await send(page, caption);
  await expect(screen.getByRole("main")).toHaveText(caption.lines.join(""));
  releaseImage?.();
  await expect(screen.getByRole("img")).toHaveCount(0);
  await expect(screen.getByRole("main")).toHaveText(caption.lines.join(""));
});
