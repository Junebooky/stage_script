import { parseShow, type PerformanceScript, type Show } from "@stage/script-schema";
import { canonicalFingerprint } from "./alignment";
import type { TimestampedASR } from "./types";

export interface RecordingReplayProfile {
  version: 1;
  recordingId: string;
  showId: string;
  numberId: string;
  canonicalFingerprint: string;
  sourceAudioPath: string;
  sourceAudioSha256: string;
  performedCueIds: string[];
  absentCueIds: string[];
  omissionBasis: string;
  asrEvidenceSource: {
    kind: "saved-provider-result"; runId: string; provider: string; model: string;
    path: string; sha256: string; wordConfidence: "unavailable"; liveLatencyMeasured: false;
  };
  nonCanonicalEvents: { type: "POST_TAKE_SPEECH"; startMs: number; endMs: number; text: string; note: string }[];
}

/** Evaluation only. Never passed to the replay controller or live matcher. */
export interface RecordingReference {
  version: 1;
  recordingId: string;
  canonicalFingerprint: string;
  quality: "silver-reference";
  basis: "asr-assisted-reference";
  provenance: string;
  cues: { cueId: string; referenceStartMs: number; warnings?: string[]; repeatGroup?: string; occurrence?: number }[];
  absentCueIds: string[];
}

export interface ASRReplayEvidence {
  version: 1;
  recordingId: string;
  sourceAudioSha256: string;
  sourceArtifactSha256: string;
  runId: string;
  provider: string;
  model: string;
  deliveryBasis: "saved-word-end-simulation";
  liveLatencyMeasured: false;
  wordConfidence: "unavailable";
  sourceSegmentCount: number;
  sourceWordCount: number;
  derivation: string;
  warnings: string[];
  transcript: TimestampedASR[];
}

export interface RegisteredReplayData {
  profile: RecordingReplayProfile;
  reference: RecordingReference;
  evidence: ASRReplayEvidence;
  durationMs: number;
  audioBytes: number;
}

const sha = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const text = (value: unknown) => typeof value === "string" && value.trim().length > 0;
const relativePath = (value: unknown) => text(value) && !(value as string).startsWith("/") && !(value as string).split(/[\\/]/).includes("..");

export function validateRecordingReplayProfile(show: Show, value: unknown): RecordingReplayProfile {
  const profile = value as RecordingReplayProfile | null;
  const parsed = parseShow(show);
  if (!profile || profile.version !== 1 || !text(profile.recordingId) || profile.showId !== parsed.id || profile.canonicalFingerprint !== canonicalFingerprint(parsed)) throw new Error("Recording profile canonical fingerprint/show mismatch");
  const number = parsed.acts.flatMap((act) => act.numbers).find((item) => item.id === profile.numberId);
  if (!number) throw new Error("Recording profile has an unknown number");
  if (!Array.isArray(profile.performedCueIds) || !profile.performedCueIds.length || !Array.isArray(profile.absentCueIds)) throw new Error("Recording cue partition is required");
  const all = [...profile.performedCueIds, ...profile.absentCueIds];
  const canonical = new Set(number.cues.map((cue) => cue.id));
  if (new Set(all).size !== all.length || all.length !== canonical.size || all.some((id) => !canonical.has(id))) throw new Error("Recording performed/absent partition has duplicate, overlapping, missing or unknown cues");
  if (!relativePath(profile.sourceAudioPath) || !sha(profile.sourceAudioSha256) || !text(profile.omissionBasis)) throw new Error("Recording audio provenance is invalid");
  const source = profile.asrEvidenceSource;
  if (!source || source.kind !== "saved-provider-result" || !text(source.runId) || !text(source.provider) || !text(source.model) || !relativePath(source.path) || !sha(source.sha256) || source.wordConfidence !== "unavailable" || source.liveLatencyMeasured !== false) throw new Error("Saved ASR provenance is required");
  if (!Array.isArray(profile.nonCanonicalEvents) || profile.nonCanonicalEvents.some((event) => !event || event.type !== "POST_TAKE_SPEECH" || !Number.isFinite(event.startMs) || !Number.isFinite(event.endMs) || event.startMs < 0 || event.endMs < event.startMs || !text(event.text) || !text(event.note))) throw new Error("Invalid non-canonical diagnostic event");
  return structuredClone(profile);
}

/** Only this recording's projection changes. IDs, order, captions and metadata are copied verbatim. */
export function buildRecordingReplayScript(show: Show, value: unknown): PerformanceScript {
  const profile = validateRecordingReplayProfile(show, value);
  const number = show.acts.flatMap((act) => act.numbers).find((item) => item.id === profile.numberId)!;
  return { title: show.title, locale: show.locale,
    segments: structuredClone(number.cues.filter((cue) => profile.performedCueIds.includes(cue.id))) };
}

export function validateRecordingReference(profile: RecordingReplayProfile, value: unknown): RecordingReference {
  const reference = value as RecordingReference | null;
  if (!reference || reference.version !== 1 || reference.recordingId !== profile.recordingId || reference.canonicalFingerprint !== profile.canonicalFingerprint || reference.quality !== "silver-reference" || reference.basis !== "asr-assisted-reference" || !text(reference.provenance)) throw new Error("Reference provenance mismatch");
  if (!Array.isArray(reference.cues) || reference.cues.length !== profile.performedCueIds.length || new Set(reference.cues.map((cue) => cue.cueId)).size !== reference.cues.length || reference.cues.some((cue, index) => !profile.performedCueIds.includes(cue.cueId) || !Number.isFinite(cue.referenceStartMs) || cue.referenceStartMs < 0 || (index > 0 && cue.referenceStartMs <= reference.cues[index - 1]!.referenceStartMs))) throw new Error("Reference must cover every performed cue once with increasing starts");
  if (!Array.isArray(reference.absentCueIds) || new Set(reference.absentCueIds).size !== reference.absentCueIds.length || reference.absentCueIds.length !== profile.absentCueIds.length || reference.absentCueIds.some((id) => !profile.absentCueIds.includes(id))) throw new Error("Reference absent partition mismatch");
  return structuredClone(reference);
}
