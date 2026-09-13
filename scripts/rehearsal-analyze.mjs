import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { createRunnableDevEnvironment, resolveConfig } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const asrCatalog = JSON.parse(await readFile(resolve(root, "data/asr-providers.json"), "utf8"));
const { values } = parseArgs({ options: { number: { type: "string" }, audio: { type: "string" }, provider: { type: "string", default: asrCatalog.defaultProviderId }, "allow-cloud-upload": { type: "boolean" }, "inspect-only": { type: "boolean" } } });
if (!asrCatalog.providers.some((provider) => provider.id === values.provider)) {
  console.error("Unknown rehearsal ASR provider; choose local, groq or soniox");
  process.exit(1);
}
// Use the installed TS module runner; no listening server and no
// duplicated matcher implementation or network dependency resolution.
const compiler = createRunnableDevEnvironment("cli", await resolveConfig({ root, configFile: false, envDir: false,
  environments: { cli: { consumer: "server", resolve: { noExternal: [/^@stage\//] }, dev: { moduleRunnerTransform: true } } }
}, "serve"), { hot: false });
await compiler.init();
try {
  const { loadProductionCatalog, requireCanonical } = await compiler.runner.import(resolve(root, "packages/script-schema/src/production.ts"));
  const catalog = loadProductionCatalog(root);
  const numberId = values.number ?? catalog.defaultNumberId;
  const show = requireCanonical(catalog, numberId);
  const dataset = catalog.datasets.find((item) => item.id === numberId);
  const audio = values.audio ?? dataset.defaultAudioPath;
  if (!audio) throw new Error("Audio path required: pass --audio");
  const id = `run-${randomUUID()}`;
  const output = resolve(root, ".stage-data", "number-analysis", id);
  await mkdir(output, { recursive: true });
  console.log(`Number: ${numberId}\nAudio: ${resolve(root, audio)}\nArtifacts: ${output}`);
  const code = await new Promise((done, reject) => {
    const child = spawn(resolve(root, "services/audio-engine/.venv/bin/python"), ["-m", "app.rehearsal_cli", "--audio", resolve(root, audio), "--output", output, "--provider", values.provider, ...(values["allow-cloud-upload"] ? ["--allow-cloud-upload"] : []), ...(values["inspect-only"] ? ["--inspect-only"] : [])],
      { cwd: resolve(root, "services/audio-engine"), stdio: "inherit", env: { ...process.env, HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" } });
    child.on("error", reject);
    child.on("exit", (status) => done(status ?? 1));
  });
  const write = (filename, value) => writeFile(resolve(output, filename), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  await write("run.json", { id, numberId, productionId: show.id, canonicalPath: dataset.canonicalPath, audioPath: audio,
    alignmentMode: "known-number-local", provider: values.provider, cloudUploadAuthorized: !!values["allow-cloud-upload"], startedFrom: "original-local-audio", productionReady: false });
  if (code !== 0 || values["inspect-only"]) process.exitCode = code;
  else {
    const { analyzeNumberRehearsal, compareCandidate, buildASRBenchmark, formatASRBenchmarkReport } = await compiler.runner.import(resolve(root, "packages/rehearsal/src/index.ts"));
    const observation = JSON.parse(await readFile(resolve(output, "observation.json"), "utf8"));
    const analysis = analyzeNumberRehearsal(show, numberId, observation.transcript, { rehearsalId: id, timestampBasis: observation.timestampBasis, asrProvider: observation.asrProvider, model: observation.model });
    await write("alignment.json", analysis);
    let comparison = null;
    if (!analysis.observations.length) {
      await write("metrics.json", { status: "NO EVALUABLE OBSERVATIONS", baseline: null, candidate: null, productionReady: false });
      console.log("No aligned cues. Review audio/model output; no candidate generated.");
    } else {
      comparison = compareCandidate(show, analysis);
      await write("metrics.json", comparison);
      await write("candidate-profile.json", { status: "candidate", sampleCount: 1, promoted: false, championId: null,
        canonicalFingerprint: analysis.canonicalFingerprint, showId: show.id, numberId, profiles: comparison.profiles, evaluation: comparison.promotion });
      console.log(`${analysis.observations.length} cue observations; ${analysis.reviewQueue.length} review items. Candidate only; no promotion.`);
    }
    const inspection = JSON.parse(await readFile(resolve(output, "inspection.json"), "utf8"));
    const benchmark = buildASRBenchmark(show, analysis, observation, inspection, comparison);
    await write("asr-benchmark.json", benchmark);
    await writeFile(resolve(output, "report.md"), formatASRBenchmarkReport(benchmark), { flag: "wx" });
    console.log(`Report: ${resolve(output, "report.md")}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await compiler.close();
}
