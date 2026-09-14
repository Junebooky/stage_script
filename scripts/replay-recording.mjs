/** Deterministic saved-evidence check, NOT real elapsed playback or ASR latency.
 * The browser demo uses HTMLAudioElement.currentTime with the same controller. */
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createRunnableDevEnvironment, resolveConfig } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { recording: { type: "string", default: "R001-M05-2" } } });
const compiler = createRunnableDevEnvironment("cli", await resolveConfig({ root, configFile: false, envDir: false,
  environments: { cli: { consumer: "server", resolve: { noExternal: [/^@stage\//] }, dev: { moduleRunnerTransform: true } } }
}, "serve"), { hot: false });
await compiler.init();
try {
  const loaded = JSON.parse(execFileSync(resolve(root, "services/audio-engine/.venv/bin/python"), ["-m", "app.registered_replay", values.recording],
    { cwd: resolve(root, "services/audio-engine"), encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }));
  const { parseShow } = await compiler.runner.import(resolve(root, "packages/script-schema/src/index.ts"));
  const { buildRecordingReplayScript, buildReplayEvidenceEvents, RealtimeReplayController, evaluateRecordingReplay } = await compiler.runner.import(resolve(root, "packages/rehearsal/src/index.ts"));
  const registry = JSON.parse(await readFile(resolve(root, "data/replay-recordings/registry.json"), "utf8"));
  const entry = registry.recordings.find((item) => item.id === values.recording);
  const show = parseShow(JSON.parse(await readFile(resolve(root, entry.canonicalPath), "utf8")));
  const script = buildRecordingReplayScript(show, loaded.profile);
  const audio = { currentTime: 0, duration: loaded.durationMs / 1000, playbackRate: 1, paused: true, ended: false, seeking: false,
    async play() { this.paused = false; }, pause() { this.paused = true; } };
  const replay = new RealtimeReplayController(script, loaded.evidence, audio);
  await replay.start();
  for (const event of buildReplayEvidenceEvents(loaded.evidence)) { audio.currentTime = event.dueAtMs / 1000; replay.tick(); }
  audio.currentTime = audio.duration; audio.ended = true; audio.paused = true;
  const state = replay.tick();
  const report = evaluateRecordingReplay(loaded.profile, loaded.reference, state.triggers, { complete: true, deliveries: state.deliveries });
  const output = resolve(root, ".stage-data/replay-evaluations", `check-${randomUUID()}`);
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, "evaluation.json"), JSON.stringify({ validationMode: "deterministic-saved-evidence-not-real-elapsed", ...report,
    sourceAudioSha256: loaded.profile.sourceAudioSha256, sourceASRSha256: loaded.evidence.sourceArtifactSha256,
    originalCanonicalCount: show.acts.flatMap((act) => act.numbers.flatMap((number) => number.cues)).length,
    projectedCueCount: script.segments.length, state }, null, 2) + "\n", { flag: "wx" });
  console.log(JSON.stringify({ validationMode: "deterministic-saved-evidence-not-real-elapsed", output, state: state.state, lastCue: state.engine.currentSegment?.id,
    nextCue: state.engine.nextSegment?.id, deliveredWords: state.evidenceCursor, ...report.metrics,
    failures: report.cues.filter((cue) => cue.failure).map(({ cueId, failure, blockedByCueId }) => ({ cueId, failure, blockedByCueId })) }, null, 2));
} finally { await compiler.close(); }
