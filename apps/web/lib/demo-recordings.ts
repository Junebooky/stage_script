/** Server-only registry loader: never ship raw provider responses or credentials. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { productionPath, productionRoot } from "@stage/script-schema/production";
import { parseShow } from "@stage/script-schema";
import { buildRecordingReplayScript, validateRecordingReference, validateRecordingReplayProfile } from "@stage/rehearsal";
import { validateDemoTimeline, type DemoRecording } from "./demo-timeline";

export function loadDemoRecordings(root = productionRoot()): DemoRecording[] {
  const read = (path: string) => readFileSync(productionPath(root, path), "utf8");
  const registry = JSON.parse(read("data/replay-recordings/registry.json"));
  if (registry.version !== 1 || !Array.isArray(registry.recordings)) throw new Error("Invalid demo registry");
  const ids = new Set<string>();
  return registry.recordings.map((entry: { id: string; canonicalPath: string; canonicalSha256: string; profilePath: string;
    referencePath: string; durationMs: number; publicAudioPath: string; defaultAudioSource?: string }) => {
    if (ids.has(entry.id) || !/^[A-Za-z0-9_-]+$/.test(entry.id)) throw new Error("Duplicate/invalid recording ID");
    ids.add(entry.id);
    const raw = read(entry.canonicalPath);
    if (createHash("sha256").update(raw).digest("hex") !== entry.canonicalSha256) throw new Error("Demo canonical hash mismatch");
    const show = parseShow(JSON.parse(raw));
    const profile = validateRecordingReplayProfile(show, JSON.parse(read(entry.profilePath)));
    if (profile.recordingId !== entry.id) throw new Error("Demo recording identity mismatch");
    const reference = validateRecordingReference(profile, JSON.parse(read(entry.referencePath)));
    if (!Number.isFinite(entry.durationMs) || entry.durationMs <= 0 || reference.cues.some((cue) => cue.referenceStartMs >= entry.durationMs)) throw new Error("Invalid demo duration");
    if (!entry.publicAudioPath?.startsWith("/") || entry.publicAudioPath.startsWith("//") || /[?#\\]/.test(entry.publicAudioPath) || entry.publicAudioPath.split("/").includes("..")) throw new Error("Invalid public audio path");
    const number = show.acts.flatMap((act) => act.numbers).find((number) => number.id === profile.numberId)!;
    return { ...validateDemoTimeline({ recordingId: entry.id, script: buildRecordingReplayScript(show, profile),
      cues: reference.cues.map(({ cueId, referenceStartMs }) => ({ cueId, referenceStartMs })) }),
      numberId: profile.numberId, title: number.title, durationMs: entry.durationMs,
      sourceAudioSha256: profile.sourceAudioSha256, audioFileName: profile.sourceAudioPath.split("/").at(-1)!,
      publicAudioPath: entry.publicAudioPath, defaultAudioSource: entry.defaultAudioSource === "registered" ? "registered" : "public",
      canonicalCueCount: number.cues.length };
  });
}
