import rawDemoScript from "../../../data/demo-script.json";

export type SegmentType = "SOLO" | "OVERLAP" | "CHORUS";

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
  metadata?: {
    scene?: string;
    song?: string;
    notes?: string;
  };
}

export interface PerformanceScript {
  title: string;
  locale: string;
  segments: ScriptSegment[];
}

const SEGMENT_TYPES = new Set<SegmentType>(["SOLO", "OVERLAP", "CHORUS"]);

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
    if (typeof segment.id !== "string" || seenIds.has(segment.id)) {
      throw new Error(`Segment ${index} has a missing or duplicate id`);
    }
    if (typeof segment.order !== "number" || seenOrders.has(segment.order)) {
      throw new Error(`Segment ${segment.id} has a missing or duplicate order`);
    }
    if (!SEGMENT_TYPES.has(segment.type as SegmentType)) {
      throw new Error(`Segment ${segment.id} has an unsupported type`);
    }
    if (!Array.isArray(segment.captions) || segment.captions.length === 0) {
      throw new Error(`Segment ${segment.id} needs captions`);
    }
    if (!Array.isArray(segment.matchText) || segment.matchText.length === 0) {
      throw new Error(`Segment ${segment.id} needs matchText`);
    }
    if (segment.type === "OVERLAP" && segment.captions.length < 2) {
      throw new Error(`OVERLAP segment ${segment.id} needs at least two captions`);
    }
    if (segment.type === "CHORUS" && segment.captions.length !== 1) {
      throw new Error(`CHORUS segment ${segment.id} must have exactly one caption`);
    }
    seenIds.add(segment.id);
    seenOrders.add(segment.order);
    return segment as unknown as ScriptSegment;
  });

  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index]!.order <= segments[index - 1]!.order) {
      throw new Error("Segments must be sorted by ascending order");
    }
  }

  return { title: source.title, locale: source.locale, segments };
}

export const demoScript = parseScript(rawDemoScript);

