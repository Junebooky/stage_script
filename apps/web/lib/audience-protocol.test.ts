import { describe, expect, it } from "vitest";
import { AudienceReadiness, AudienceReplica, decodeAudienceFrame, localAsset, OUTPUT_TIMEOUT_MS } from "./audience-protocol";

const frame = { type: "state", version: 1, session: "operator-1", epoch: 100, sequence: 1, view: { kind: "caption", cueId: "cue-1", lines: ["확정된 대본"] } };

describe("authoritative audience protocol", () => {
  it("copies only audience fields, never raw recognition or controls", () => {
    const decoded = decodeAudienceFrame({ ...frame, rawASR: "틀린 대사", debug: true, view: { ...frame.view, actor: "metadata", heardText: "인식" } });
    expect(decoded).toEqual(frame);
    expect(JSON.stringify(decoded)).not.toMatch(/틀린|debug|actor|heardText/);
  });
  it("rejects duplicate, out-of-order and obsolete-authority snapshots", () => {
    const replica = new AudienceReplica();
    expect(replica.accept(frame)).not.toBeNull();
    expect(replica.accept(frame)).toBeNull();
    expect(replica.accept({ ...frame, sequence: 0 })).toBeNull();
    expect(replica.accept({ ...frame, epoch: 200, session: "operator-2", sequence: 1 })).not.toBeNull();
    expect(replica.accept({ ...frame, sequence: 99 })).toBeNull();
  });
  it("requires explicit local images and rejects external dependencies", () => {
    expect(localAsset("/bg_image/decadence_gyeongseong_m07_night_stage_01.jpg")).toBe(true);
    for (const src of ["https://example.com/a.jpg", "//example.com/a.jpg", "/%2fexample.com/a.jpg", "javascript:x", "/../private", "data:image/png,x", "/%252e%252e/a.jpg", "/%2e%2e/a.jpg", "/a/../b.jpg", "/a.jpg?url=https://remote.test/a.jpg", "/external.svg", "/api", "/a\\evil.jpg"]) expect(localAsset(src)).toBe(false);
    expect(decodeAudienceFrame({ ...frame, view: { kind: "image", cueId: "image", src: "https://example.com/a.jpg", alt: "" } })).toBeNull();
  });
  it("retains the last accepted output when no new operator state arrives", () => {
    const replica = new AudienceReplica();
    replica.accept(frame);
    replica.accept({ type: "manualNext" });
    expect(replica.frame).toEqual(frame);
  });
  it("rejects malformed authority identifiers and numeric clocks", () => {
    for (const invalid of [{ session: "" }, { session: "x".repeat(257) }, { epoch: NaN }, { epoch: -1 }, { epoch: 0.5 }, { epoch: Number.MAX_SAFE_INTEGER + 1 }, { sequence: -1 }, { sequence: 0.1 }]) expect(decodeAudienceFrame({ ...frame, ...invalid })).toBeNull();
    expect(decodeAudienceFrame({ ...frame, view: { kind: "caption", cueId: "", lines: ["text"] } })).toBeNull();
    expect(decodeAudienceFrame({ ...frame, view: { kind: "caption", cueId: "c", lines: ["x".repeat(4001)] } })).toBeNull();
  });
  it("does not let an existing session rewrite its immutable epoch", () => {
    const replica = new AudienceReplica();
    replica.accept(frame);
    expect(replica.accept({ ...frame, epoch: 999, sequence: 2 })).toBeNull();
    expect(replica.accept({ ...frame, sequence: 2 })).not.toBeNull();
  });
  it("recovers an authoritative snapshot after reload and keeps ordering on reconnect", () => {
    const replica = new AudienceReplica();
    expect(replica.accept({ ...frame, sequence: 501 })).not.toBeNull();
    expect(replica.accept({ ...frame, epoch: 101, session: "reloaded", sequence: 1 })).not.toBeNull();
    expect(replica.accept({ ...frame, sequence: 9999 })).toBeNull();
  });
  it("only acknowledges the latest snapshot and expires renderer readiness", () => {
    const readiness = new AudienceReadiness();
    const decoded = decodeAudienceFrame(frame)!;
    readiness.sent(decoded);
    const ack = { type: "ack", version: 1, audience: "screen-1", session: frame.session, epoch: frame.epoch, sequence: 1, ready: true };
    for (const invalid of [{ sequence: 0 }, { sequence: 2 }, { sequence: NaN }, { ready: "true" }, { audience: "" }, { epoch: 99 }, { session: "obsolete" }]) expect(readiness.accept({ ...ack, ...invalid }, 10)).toBe(false);
    expect(readiness.connected(10)).toBe(false);
    expect(readiness.accept(ack, 10)).toBe(true);
    expect(readiness.connected(10 + OUTPUT_TIMEOUT_MS - 1)).toBe(true);
    expect(readiness.connected(10 + OUTPUT_TIMEOUT_MS)).toBe(false);
    readiness.sent({ ...decoded, sequence: 2, view: { kind: "image", cueId: "image", src: "/bg_image/show.jpg", alt: "" } });
    expect(readiness.connected(11)).toBe(false);
    expect(readiness.accept(ack, 12)).toBe(false);
    expect(readiness.accept({ ...ack, sequence: 2, ready: false }, 13)).toBe(true);
    expect(readiness.connected(13)).toBe(false);
    expect(readiness.accept({ ...ack, sequence: 2 }, 14)).toBe(true);
    expect(readiness.connected(14)).toBe(true);
  });
});
