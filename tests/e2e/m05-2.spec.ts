import { test, expect, type Page } from "@playwright/test";
import canonical from "../../data/productions/decadence-gyeongseong/numbers/M05-2.json" with { type: "json" };

async function browserFixture(page: Page) {
  await page.addInitScript(() => {
    const instances: Fixture[] = [];
    class Fixture {
      onstart?: () => void;
      onend?: () => void;
      onresult?: (event: unknown) => void;
      constructor() { instances.push(this); }
      start() { queueMicrotask(() => this.onstart?.()); }
      abort() { this.onend?.(); }
      stop() { this.onend?.(); }
    }
    Object.assign(window, { SpeechRecognition: Fixture, m05Fixture: {
      emit(text: string, index: number, old = false) {
        const instance = old ? instances[instances.length - 2] : instances.at(-1);
        instance?.onresult?.({ resultIndex: index, results: { length: index + 1,
          [index]: { isFinal: old, length: 1, 0: { transcript: text, confidence: 0.99 } } } });
      }
    } });
  });
}
async function emit(page: Page, text: string, index = 0, old = false) {
  await page.evaluate(({ text, index, old }) => {
    (window as unknown as { m05Fixture: { emit: (text: string, index: number, old: boolean) => void } }).m05Fixture.emit(text, index, old);
  }, { text, index, old });
}

test("M05-2 defaults: browser interim cues all 36 canonical lines, no local model or final results", async ({ page, context }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await browserFixture(page);
  await context.grantPermissions(["microphone"]);
  let backendRequests = 0;
  await page.route("**/localhost:8000/**", (route) => { backendRequests++; return route.abort(); });
  await page.goto("/");
  await expect(page).toHaveURL(/\/operator$/);
  await page.getByRole("button", { name: "🎙️ 라이브 마이크 모드" }).click();
  await expect(page.getByRole("heading", { name: "데카당스 경성" })).toBeVisible();
  await expect(page.getByLabel("Performance ASR source")).toHaveValue("browser-preview");
  const audience = await context.newPage();
  await audience.goto("/output");
  const output = audience.getByRole("main");
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await expect(page.getByLabel("Show lifecycle")).toHaveAttribute("data-show-state", "ACT_LIVE");
  for (const [index, cue] of canonical.acts[0]!.numbers[0]!.cues.entries()) {
    await emit(page, cue.matchText[0]!, index);
    await expect(output).toHaveAttribute("data-cue", cue.id);
    await expect(output).toHaveText(cue.captions.map((line) => line.text).join(""));
  }
  await page.getByRole("button", { name: "Stop microphone", exact: true }).click();
  await page.screenshot({ path: "/tmp/m05-2-online-preview.png", fullPage: true });
  expect(backendRequests).toBe(0);
  expect(errors).toEqual([]);
});

test("M05-2 online manual fences ignore old browser finals and keep microphone text separate", async ({ page, context }) => {
  await browserFixture(page);
  await context.grantPermissions(["microphone"]);
  await page.goto("/operator");
  await page.getByRole("button", { name: "🎙️ 라이브 마이크 모드" }).click();
  const audience = await context.newPage();
  await audience.goto("/output");
  const output = audience.getByRole("main");
  await page.getByRole("button", { name: "Start microphone", exact: true }).click();
  await expect(page.getByLabel("Show lifecycle")).toHaveAttribute("data-show-state", "ACT_LIVE");
  await emit(page, "창가로 스며드는");
  await expect(output).toHaveText("창가로 스며드는 외로운 저 달빛");
  await expect(page.getByLabel("Recognized speech")).toHaveText("창가로 스며드는");
  await page.getByRole("button", { name: "Send next cue" }).click();
  await expect(output).toHaveAttribute("data-cue", "M05-2_C002");
  await emit(page, "내 성을 맴돌던 그대의 그림자", 0, true);
  await expect(output).toHaveAttribute("data-cue", "M05-2_C002");
  await expect(page.getByLabel("Recognized speech")).toHaveText("창가로 스며드는");
  await emit(page, "내 성을 맴돌던");
  await expect(output).toHaveAttribute("data-cue", "M05-2_C003");
  await page.getByRole("button", { name: "Stop microphone", exact: true }).click();
});

test("real rehearsal defaults to external ASR but cannot upload without explicit consent", async ({ page }) => {
  await page.goto("/rehearsal");
  await expect(page.getByLabel("Rehearsal ASR provider")).toHaveValue("groq");
  await expect(page.getByLabel("Upload rehearsal audio")).toBeDisabled();
  await page.getByLabel("Allow external audio upload").check();
  await expect(page.getByLabel("Upload rehearsal audio")).toBeEnabled();
  await page.getByLabel("Rehearsal ASR provider").selectOption("local");
  await page.getByLabel("Rehearsal ASR provider").selectOption("soniox");
  await expect(page.getByLabel("Allow external audio upload")).not.toBeChecked();
  await expect(page.getByLabel("Upload rehearsal audio")).toBeDisabled();
});
