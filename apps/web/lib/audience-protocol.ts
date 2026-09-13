import { isLocalImageSource as localAsset } from "@stage/script-schema/assets";
export { isLocalImageSource as localAsset } from "@stage/script-schema/assets";

export const OUTPUT_CHANNEL = "cueflow-local-output-v1";
export const OPERATOR_LOCK = "cueflow-authoritative-operator-v1";
export const OUTPUT_HEARTBEAT_MS = 500;
export const OUTPUT_TIMEOUT_MS = 2500;

export type AudienceView =
  | { kind: "black" }
  | { kind: "caption"; cueId: string; lines: string[] }
  | { kind: "image"; cueId: string; src: string; alt: string };

export interface AudienceFrame {
  type: "state";
  version: 1;
  session: string;
  epoch: number;
  sequence: number;
  view: AudienceView;
}

function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

export function decodeAudienceFrame(value: unknown): AudienceFrame | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (raw.type !== "state" || raw.version !== 1 || !identifier(raw.session) || typeof raw.epoch !== "number" || !Number.isSafeInteger(raw.epoch) || raw.epoch < 0 || typeof raw.sequence !== "number" || !Number.isSafeInteger(raw.sequence) || raw.sequence < 0) return null;
  if (!raw.view || typeof raw.view !== "object") return null;
  const view = raw.view as Record<string, unknown>;
  let clean: AudienceView;
  if (view.kind === "black") clean = { kind: "black" };
  else if (view.kind === "caption" && identifier(view.cueId) && Array.isArray(view.lines) && view.lines.length > 0 && view.lines.length <= 8 && view.lines.every((line) => typeof line === "string" && line.length <= 4000)) {
    clean = { kind: "caption", cueId: view.cueId, lines: [...view.lines] as string[] };
  } else if (view.kind === "image" && identifier(view.cueId) && typeof view.src === "string" && localAsset(view.src) && typeof view.alt === "string" && view.alt.length <= 2000) {
    clean = { kind: "image", cueId: view.cueId, src: view.src, alt: view.alt };
  } else return null;
  // Whitelist payload fields. ASR, actors, controls and diagnostics never cross here.
  return { type: "state", version: 1, session: raw.session, epoch: raw.epoch, sequence: raw.sequence, view: clean };
}

/** Read-only replica: no script, matching logic, navigation or local cue pointer. */
export class AudienceReplica {
  frame: AudienceFrame | null = null;
  accept(raw: unknown): AudienceFrame | null {
    const next = decodeAudienceFrame(raw);
    if (!next) return null;
    if (this.frame) {
      if (next.epoch < this.frame.epoch) return null;
      if (next.session === this.frame.session && next.epoch !== this.frame.epoch) return null;
      if (next.session === this.frame.session && next.sequence <= this.frame.sequence) return null;
      if (next.session !== this.frame.session && next.epoch === this.frame.epoch && next.session < this.frame.session) return null;
    }
    this.frame = next;
    return next;
  }
}

/** Readiness applies to the latest snapshot, never to a delayed previous cue ACK. */
export class AudienceReadiness {
  private latest: AudienceFrame | null = null;
  private ready = false;
  private acknowledgedAt = Number.NEGATIVE_INFINITY;

  sent(frame: AudienceFrame) {
    if (!this.latest || frame.session !== this.latest.session || JSON.stringify(frame.view) !== JSON.stringify(this.latest.view)) this.ready = false;
    this.latest = frame;
  }

  accept(raw: unknown, now: number): boolean {
    if (!raw || typeof raw !== "object" || !this.latest) return false;
    const ack = raw as Record<string, unknown>;
    if (ack.type !== "ack" || ack.version !== 1 || !identifier(ack.audience) || ack.session !== this.latest.session || ack.epoch !== this.latest.epoch || ack.sequence !== this.latest.sequence || typeof ack.ready !== "boolean") return false;
    this.ready = ack.ready;
    this.acknowledgedAt = now;
    return true;
  }

  connected(now: number): boolean {
    return this.ready && now - this.acknowledgedAt < OUTPUT_TIMEOUT_MS;
  }
}
