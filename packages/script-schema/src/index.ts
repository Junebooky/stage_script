import rawDemoScript from "../../../data/demo-script.json";
import { isLocalImageSource } from "./assets";
export { isLocalImageSource } from "./assets";

export type OperatingMode = "DEMO" | "PERFORMANCE_LOCAL";
export type SegmentType = "SOLO" | "CAPTION" | "OVERLAP" | "CHORUS" | "IMAGE";

export interface CueProfile {
  cueId: string;
  anchors: { text: string; reliability: number; repetitionRisk?: number; competingCueIds?: string[] }[];
  timing: { medianAfterPreviousMs: number; earlyToleranceMs: number; lateToleranceMs: number; varianceMs2: number; sampleCount?: number; distributionReady?: boolean };
  status?: "candidate";
  thresholds: { text: number; fallback: number };
  fallback: { enabled: boolean };
  sampleCount: number;
  confidence: number;
}

export interface CaptionLine {
  actor: string;
  text: string;
}

export interface ScriptSegment {
  id: string;
  order: number;
  type: SegmentType;
  captions: CaptionLine[];
  matchText: string[];
  image?: { src: string; alt: string };
  profile?: CueProfile;
  metadata?: {
    scene?: string;
    song?: string;
    notes?: string;
    actId?: string;
    numberId?: string;
    section?: string;
    delivery?: "spoken" | "sung";
    ensemble?: "solo" | "duet" | "chorus";
    performers?: string[];
    repeatGroup?: string;
    repeatOccurrence?: number;
  };
}

export interface PerformanceScript {
  title: string;
  locale: string;
  segments: ScriptSegment[];
}

export type Cue = ScriptSegment;
export interface MusicalNumber { id: string; title: string; cues: Cue[] }
export interface Act { id: string; title: string; numbers: MusicalNumber[] }
export interface Show { id: string; title: string; locale: string; acts: Act[] }

const SEGMENT_TYPES = new Set<SegmentType>(["SOLO", "CAPTION", "OVERLAP", "CHORUS", "IMAGE"]);

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function finite(value: unknown, label: string, maximum = Infinity): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) throw new Error(`${label} is invalid`);
  return value;
}

export function parseCueProfile(value: unknown): CueProfile {
  const source = object(value, "Cue profile");
  if (typeof source.cueId !== "string" || !source.cueId.trim()) throw new Error("Cue profile cueId is required");
  if (!Array.isArray(source.anchors)) throw new Error("Cue profile anchors are required");
  const anchors = source.anchors.map((value) => {
    const anchor = object(value, "Anchor");
    if (typeof anchor.text !== "string" || !anchor.text.trim()) throw new Error("Anchor text is required");
    if (anchor.competingCueIds !== undefined && (!Array.isArray(anchor.competingCueIds) || !anchor.competingCueIds.every((id) => typeof id === "string"))) throw new Error("Invalid anchor collisions");
    return { text: anchor.text, reliability: finite(anchor.reliability, "Anchor reliability", 1),
      ...(anchor.repetitionRisk !== undefined ? { repetitionRisk: finite(anchor.repetitionRisk, "Repetition risk", 1) } : {}),
      ...(anchor.competingCueIds !== undefined ? { competingCueIds: anchor.competingCueIds as string[] } : {}) };
  });
  const timing = object(source.timing, "Profile timing");
  const thresholds = object(source.thresholds, "Profile thresholds");
  const fallback = object(source.fallback, "Profile fallback");
  if (typeof fallback.enabled !== "boolean") throw new Error("Fallback enabled must be explicit");
  const sampleCount = finite(source.sampleCount, "Profile sampleCount");
  if (!Number.isInteger(sampleCount)) throw new Error("Profile sampleCount must be an integer");
  if (timing.sampleCount !== undefined && (!Number.isInteger(timing.sampleCount) || finite(timing.sampleCount, "Timing sampleCount") > sampleCount)) throw new Error("Invalid timing sample count");
  if (timing.distributionReady !== undefined && typeof timing.distributionReady !== "boolean") throw new Error("Invalid timing distribution flag");
  if (timing.distributionReady === true && (typeof timing.sampleCount !== "number" || timing.sampleCount < 3)) throw new Error("Timing distribution needs at least three independent recordings");
  if (source.status !== undefined && source.status !== "candidate") throw new Error("Invalid profile evidence status");
  return {
    cueId: source.cueId, anchors,
    timing: { medianAfterPreviousMs: finite(timing.medianAfterPreviousMs, "Median timing"), earlyToleranceMs: finite(timing.earlyToleranceMs, "Early tolerance"), lateToleranceMs: finite(timing.lateToleranceMs, "Late tolerance"), varianceMs2: finite(timing.varianceMs2, "Timing variance"), ...(timing.sampleCount !== undefined ? { sampleCount: timing.sampleCount as number, distributionReady: timing.distributionReady === true } : {}) },
    ...(source.status === "candidate" ? { status: "candidate" as const } : {}),
    thresholds: { text: finite(thresholds.text, "Text threshold", 1), fallback: finite(thresholds.fallback, "Fallback threshold", 1) },
    fallback: { enabled: fallback.enabled }, sampleCount, confidence: finite(source.confidence, "Profile confidence", 1)
  };
}

export function parseCueProfiles(value: unknown): CueProfile[] {
  if (!Array.isArray(value)) throw new Error("Cue profiles must be an array");
  const profiles = value.map(parseCueProfile);
  if (new Set(profiles.map((profile) => profile.cueId)).size !== profiles.length) throw new Error("Duplicate cue profile");
  return profiles;
}

export function parseScript(value: unknown): PerformanceScript {
  if (!value || typeof value !== "object") throw new Error("Script must be an object");
  const source = value as Record<string, unknown>;
  if (typeof source.title !== "string" || typeof source.locale !== "string") {
    throw new Error("Script title and locale are required");
  }
  if (!Array.isArray(source.segments) || source.segments.length === 0) {
    throw new Error("Script must contain at least one segment");
  }

  const seenIds = new Set<string>();
  const seenOrders = new Set<number>();
  const segments = source.segments.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Segment ${index} is invalid`);
    const segment = item as Record<string, unknown>;
    if (typeof segment.id !== "string" || !segment.id.trim() || segment.id.length > 256 || seenIds.has(segment.id)) {
      throw new Error(`Segment ${index} has a missing or duplicate id`);
    }
    if (typeof segment.order !== "number" || !Number.isSafeInteger(segment.order) || seenOrders.has(segment.order)) {
      throw new Error(`Segment ${segment.id} has a missing or duplicate order`);
    }
    if (!SEGMENT_TYPES.has(segment.type as SegmentType)) {
      throw new Error(`Segment ${segment.id} has an unsupported type`);
    }
    if (!Array.isArray(segment.captions) || (segment.type !== "IMAGE" && segment.captions.length === 0)) {
      throw new Error(`Segment ${segment.id} needs captions`);
    }
    if (segment.captions.length > 8) throw new Error("Audience output supports at most eight simultaneous caption lines");
    if (!Array.isArray(segment.matchText) || (segment.type !== "IMAGE" && segment.matchText.length === 0)) {
      throw new Error(`Segment ${segment.id} needs matchText`);
    }
    if (segment.type === "OVERLAP" && segment.captions.length < 2) {
      throw new Error(`OVERLAP segment ${segment.id} needs at least two captions`);
    }
    if (segment.type === "CHORUS" && segment.captions.length !== 1) {
      throw new Error(`CHORUS segment ${segment.id} must have exactly one caption`);
    }
    for (const line of segment.captions) {
      const caption = object(line, "Caption");
      if (typeof caption.actor !== "string" || typeof caption.text !== "string" || !caption.text.trim() || caption.text.length > 4000) throw new Error(`Segment ${segment.id} has an invalid caption`);
    }
    if (!segment.matchText.every((text) => typeof text === "string" && text.trim())) throw new Error(`Segment ${segment.id} has invalid matchText`);
    if (segment.type === "IMAGE") {
      const image = object(segment.image, "Image cue asset");
      if (typeof image.src !== "string" || !isLocalImageSource(image.src) || typeof image.alt !== "string" || image.alt.length > 2000) throw new Error("Image cues require a validated local image asset");
      if (segment.captions.length || segment.matchText.length) throw new Error("Image cues cannot contain caption or recognition text");
    }
    if (segment.profile) {
      const profile = parseCueProfile(segment.profile);
      if (profile.cueId !== segment.id) throw new Error("Cue profile id does not match cue");
    }
    seenIds.add(segment.id);
    seenOrders.add(segment.order);
    return structuredClone(segment) as unknown as ScriptSegment;
  });

  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index]!.order <= segments[index - 1]!.order) {
      throw new Error("Segments must be sorted by ascending order");
    }
  }

  return { title: source.title, locale: source.locale, segments };
}

export function migrateScriptToShow(script: PerformanceScript, id = "imported-show"): Show {
  const parsed = parseScript(script);
  const acts: Act[] = [];
  for (const cue of parsed.segments) {
    const title = cue.metadata?.scene ?? "Act 1";
    let act = acts.at(-1);
    if (!act || act.title !== title) { act = { id: `act-${acts.length + 1}`, title, numbers: [] }; acts.push(act); }
    const numberTitle = cue.metadata?.song ?? parsed.title;
    let number = act.numbers.at(-1);
    if (!number || number.title !== numberTitle) { number = { id: `${act.id}-number-${act.numbers.length + 1}`, title: numberTitle, cues: [] }; act.numbers.push(number); }
    number.cues.push({ ...cue, type: cue.type === "SOLO" ? "CAPTION" : cue.type });
  }
  return { id, title: parsed.title, locale: parsed.locale, acts };
}

export function parseShow(value: unknown): Show {
  const source = object(value, "Show");
  if (Array.isArray(source.segments)) return migrateScriptToShow(parseScript(source));
  for (const key of ["id", "title", "locale"]) if (typeof source[key] !== "string" || !source[key].trim()) throw new Error(`Show ${key} is required`);
  if ((source.id as string).length > 200) throw new Error("Show id must be at most 200 characters");
  if (!Array.isArray(source.acts) || !source.acts.length) throw new Error("Show needs acts");
  const ids = new Set<string>();
  const identify = (record: Record<string, unknown>, kind: string) => {
    if (typeof record.id !== "string" || !record.id.trim() || ids.has(record.id)) throw new Error(`${kind} has missing or duplicate id`);
    if (typeof record.title !== "string") throw new Error(`${kind} needs title`);
    ids.add(record.id);
  };
  const cueIds = new Set<string>();
  const acts = source.acts.map((value) => {
    const act = object(value, "Act"); identify(act, "Act");
    if (!Array.isArray(act.numbers) || !act.numbers.length) throw new Error("Act needs numbers");
    const numbers = act.numbers.map((value) => {
      const number = object(value, "Number"); identify(number, "Number");
      const cues = parseScript({ title: number.title, locale: source.locale, segments: number.cues }).segments;
      for (const cue of cues) {
        if (cueIds.has(cue.id)) throw new Error("Duplicate cue id across show");
        cueIds.add(cue.id);
      }
      return { id: number.id as string, title: number.title as string, cues: cues.map((cue) => ({ ...cue, type: cue.type === "SOLO" ? "CAPTION" as const : cue.type })) };
    });
    return { id: act.id as string, title: act.title as string, numbers };
  });
  return { id: source.id as string, title: source.title as string, locale: source.locale as string, acts };
}

/** Canonical authoring data is copied, never rewritten with ASR observations. */
export function flattenShow(show: Show, actId?: string): PerformanceScript {
  const parsed = parseShow(show);
  if (actId && !parsed.acts.some((act) => act.id === actId)) throw new Error("Unknown act");
  const segments = parsed.acts.filter((act) => !actId || act.id === actId).flatMap((act) => act.numbers.flatMap((number) => number.cues.map((cue) => ({ ...cue, metadata: { ...cue.metadata, actId: act.id, numberId: number.id } }))));
  return { title: parsed.title, locale: parsed.locale, segments: segments.map((cue, index) => ({ ...cue, order: index + 1 })) };
}

export const demoScript = parseScript(rawDemoScript);
export const demoShow = migrateScriptToShow(demoScript, "demo-show");
