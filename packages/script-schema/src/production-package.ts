import { isLocalImageSource } from "./assets";

/** Authoring contract only. A valid draft is not a live-approved show. */
export type TrackingKind = "LYRIC" | "DIALOGUE" | "NARRATION";
export type FrameTrigger = { kind: "MANUAL" } | { kind: "SPEECH"; cueId: string };
export type TextRole = "LYRIC" | "DIALOGUE" | "NARRATION" | "LOCATION" | "OTHER";
export interface FrameColumn { actor?: string; rows: (string | null)[] }
export interface FrameBase { id: string; actId: string; sceneId?: string; trigger: FrameTrigger; sourceRefs: string[] }
export type ProductionFrame = FrameBase & (
  | { kind: "BLACK" }
  | { kind: "IMAGE"; image: { src: string; alt: string } }
  | { kind: "TEXT"; role: TextRole; columns: FrameColumn[] }
);
export interface ProductionTrackingCue {
  id: string;
  actId: string;
  sceneId?: string;
  songId?: string;
  kind: TrackingKind;
  matchText: string[];
  performers: string[];
  /** Association only, not authority to change the audience frame. */
  frameId?: string;
  sourceRefs: string[];
}
export interface ProductionSong { id: string; displayNumber: string; title: string }
export interface ProductionDesign {
  aspectRatio: { width: number; height: number };
  background: string;
  foreground: string;
  fontFamily: string;
  verticalAlign: "TOP" | "CENTER" | "BOTTOM";
  preferredRows: number;
}
export interface ProductionPackageDraft {
  version: 1;
  status: "draft";
  productionId: string;
  revisionId: string;
  title: string;
  locale: string;
  design: ProductionDesign;
  acts: { id: string; title: string }[];
  songs: ProductionSong[];
  trackingCues: ProductionTrackingCue[];
  frames: ProductionFrame[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be an object");
  return value as Record<string, unknown>;
}
function string(value: unknown, label: string, max = 4000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Invalid " + label);
  return value; // Never normalize or rewrite canonical text.
}
function id(value: unknown, label: string): string { return string(value, label, 256); }
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(label + " must be an array");
  return value;
}
function strings(value: unknown, label: string): string[] {
  return array(value, label).map((v) => string(v, label));
}
function choice<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error("Invalid " + label);
  return value as T;
}
function positive(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error("Invalid " + label);
  return value;
}
function color(value: unknown): string {
  if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error("Invalid design color");
  return value;
}
function unique<T extends { id: string }>(items: T[], label: string): Map<string, T> {
  const map = new Map(items.map((item) => [item.id, item]));
  if (map.size !== items.length) throw new Error("Duplicate " + label + " id");
  return map;
}

/** Validate references and order without altering the legacy script/recording schemas.
 * Ordered arrays are canonical; no rehearsal timestamps are required.
 * The parser constructs a whitelist of fields, not a cast of arbitrary input.
 */
export function parseProductionPackageDraft(value: unknown): ProductionPackageDraft {
  const raw = record(value, "Production package");
  if (raw.version !== 1 || raw.status !== "draft") throw new Error("Expected draft package version 1");
  const d = record(raw.design, "Design");
  const ratio = record(d.aspectRatio, "Aspect ratio");
  const design: ProductionDesign = {
    aspectRatio: { width: positive(ratio.width, "aspect width", 10000), height: positive(ratio.height, "aspect height", 10000) },
    background: color(d.background), foreground: color(d.foreground),
    fontFamily: string(d.fontFamily, "font family", 256),
    verticalAlign: choice(d.verticalAlign, ["TOP", "CENTER", "BOTTOM"], "vertical alignment"),
    preferredRows: positive(d.preferredRows, "preferred rows", 32),
  };
  const acts = array(raw.acts, "Acts").map((item) => {
    const a = record(item, "Act");
    return { id: id(a.id, "act id"), title: string(a.title, "act title") };
  });
  if (!acts.length) throw new Error("At least one act required");
  unique(acts, "act");
  const actOrder = new Map(acts.map((a, i) => [a.id, i]));
  const songs = array(raw.songs, "Songs").map((item) => {
    const s = record(item, "Song");
    return { id: id(s.id, "song id"), displayNumber: id(s.displayNumber, "display number"), title: string(s.title, "song title") };
  });
  const songMap = unique(songs, "song");
  if (new Set(songs.map(s => s.displayNumber)).size !== songs.length) throw new Error("Duplicate display number");
  function scope(r: Record<string, unknown>) {
    const actId = id(r.actId, "act reference");
    if (!actOrder.has(actId)) throw new Error("Unknown act");
    return { actId, ...(r.sceneId === undefined ? {} : { sceneId: id(r.sceneId, "scene id") }) };
  }
  const trackingCues: ProductionTrackingCue[] = array(raw.trackingCues, "Tracking cues").map((item) => {
    const c = record(item, "Tracking cue");
    const matchText = strings(c.matchText, "match text");
    if (!matchText.length) throw new Error("Tracking cue needs real speech evidence");
    const songId = c.songId === undefined ? undefined : id(c.songId, "song reference");
    if (songId !== undefined && !songMap.has(songId)) throw new Error("Unknown song");
    return { id: id(c.id, "cue id"), ...scope(c), ...(songId === undefined ? {} : { songId }),
      kind: choice(c.kind, ["LYRIC", "DIALOGUE", "NARRATION"], "tracking kind"), matchText,
      performers: strings(c.performers, "performers"), sourceRefs: strings(c.sourceRefs, "source references"),
      ...(c.frameId === undefined ? {} : { frameId: id(c.frameId, "frame reference") }) };
  });
  const cueMap = unique(trackingCues, "cue");
  const frames: ProductionFrame[] = array(raw.frames, "Frames").map((item) => {
    const f = record(item, "Frame");
    const t = record(f.trigger, "Trigger");
    const triggerKind = choice(t.kind, ["MANUAL", "SPEECH"], "trigger kind");
    const trigger: FrameTrigger = triggerKind === "MANUAL" ? { kind: "MANUAL" } : { kind: "SPEECH", cueId: id(t.cueId, "trigger cue") };
    const base: FrameBase = { id: id(f.id, "frame id"), ...scope(f), trigger, sourceRefs: strings(f.sourceRefs, "source references") };
    const kind = choice(f.kind, ["BLACK", "IMAGE", "TEXT"], "frame kind");
    if (kind === "BLACK") return { ...base, kind };
    if (kind === "IMAGE") {
      const im = record(f.image, "Image");
      if (typeof im.src !== "string" || !isLocalImageSource(im.src) || typeof im.alt !== "string" || im.alt.length > 2000) throw new Error("Invalid local image");
      return { ...base, kind, image: { src: im.src, alt: im.alt } };
    }
    const columns = array(f.columns, "Columns").map((item): FrameColumn => {
      const col = record(item, "Column");
      const rows = array(col.rows, "Rows").map((v) => v === null ? null : string(v, "caption row"));
      if (!rows.length || rows.length > 32) throw new Error("Invalid row count");
      return { ...(col.actor === undefined ? {} : { actor: string(col.actor, "actor", 256) }), rows };
    });
    if (!columns.length || columns.length > 8 || !columns.some(c => c.rows.some(r => r !== null))) throw new Error("Text frame needs content");
    if (!columns.every(c => c.rows.length === columns[0]!.rows.length)) throw new Error("Column rows must align; use null for blank cells");
    return { ...base, kind, role: choice(f.role, ["LYRIC", "DIALOGUE", "NARRATION", "LOCATION", "OTHER"], "text role"), columns };
  });
  if (!frames.length) throw new Error("At least one frame required");
  const frameMap = unique(frames, "frame");
  function ordered(items: { actId: string }[]) {
    for (let i = 1; i < items.length; i++) {
      if (actOrder.get(items[i]!.actId)! < actOrder.get(items[i - 1]!.actId)!) throw new Error("Act order must not go backwards");
    }
  }
  ordered(trackingCues); ordered(frames);
  const frameOrder = new Map(frames.map((f, i) => [f.id, i]));
  const cueOrder = new Map(trackingCues.map((c, i) => [c.id, i]));
  let lastFrame = -1;
  const firstCueByFrame = new Map<string, string>();
  for (const cue of trackingCues) {
    if (cue.frameId === undefined) continue;
    const frame = frameMap.get(cue.frameId);
    if (!frame || frame.actId !== cue.actId || frame.sceneId !== cue.sceneId) throw new Error("Invalid cue frame reference");
    const order = frameOrder.get(frame.id)!;
    if (order < lastFrame) throw new Error("Cue frame order must not go backwards");
    lastFrame = order;
    if (!firstCueByFrame.has(frame.id)) firstCueByFrame.set(frame.id, cue.id);
  }
  let lastTrigger = -1;
  for (const frame of frames) {
    if (frame.trigger.kind !== "SPEECH") continue;
    const cue = cueMap.get(frame.trigger.cueId);
    if (!cue || cue.frameId !== frame.id || firstCueByFrame.get(frame.id) !== cue.id) throw new Error("Speech trigger must reference the first associated cue");
    const order = cueOrder.get(cue.id)!;
    if (order <= lastTrigger) throw new Error("Speech triggers must be ordered");
    lastTrigger = order;
  }
  return { version: 1, status: "draft", productionId: id(raw.productionId, "production id"),
    revisionId: id(raw.revisionId, "revision id"), title: string(raw.title, "title"), locale: id(raw.locale, "locale"),
    design, acts, songs, trackingCues, frames };
}
