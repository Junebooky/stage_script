import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProductionCatalog, productionPath, requireCanonical } from "./production";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(resolve(tmpdir(), "cueflow-registry-test-"));
  roots.push(root);
  mkdirSync(resolve(root, "data/productions"), { recursive: true });
  const show = { id: "test-production", title: "TEST ONLY", locale: "ko-KR", acts: [{ id: "act", title: "Act", numbers: [{ id: "test-one", title: "Test number", cues: [
    { id: "test-cue", order: 1, type: "CAPTION", captions: [{ actor: "Test", text: "합성 검증 문장" }], matchText: ["합성 검증 문장"] }
  ] }] }] };
  const registry = { version: 1, defaultNumberId: "test-one", productions: [{ id: show.id, title: show.title, locale: show.locale, numbers: [
    { id: "test-one", title: "Test number", canonicalPath: "data/productions/one.json", rehearsalDirectory: "recordings/test" }
  ] }] };
  const write = () => {
    writeFileSync(resolve(root, "data/productions/registry.json"), JSON.stringify(registry));
    writeFileSync(resolve(root, "data/productions/one.json"), JSON.stringify(show));
  };
  write();
  return { root, registry, show, write };
}
describe("generic production registry (temporary synthetic data only)", () => {
  it("supports additive number registration without code changes and fails closed without canonical", () => {
    const { root, registry, show, write } = fixture();
    expect(requireCanonical(loadProductionCatalog(root)).id).toBe(show.id);
    registry.productions[0]!.numbers.push({ id: "test-future", title: "TEST ONLY", canonicalPath: "data/productions/future.json", rehearsalDirectory: "recordings/test-future" });
    write();
    const missing = loadProductionCatalog(root);
    expect(missing.datasets[1]!.status).toBe("CANONICAL SCRIPT REQUIRED");
    expect(() => requireCanonical(missing, "test-future")).toThrow("CANONICAL SCRIPT REQUIRED");
    const future = structuredClone(show);
    future.acts[0]!.numbers[0]!.id = "test-future";
    writeFileSync(resolve(root, "data/productions/future.json"), JSON.stringify(future));
    const expanded = loadProductionCatalog(root);
    expect(requireCanonical(expanded, "test-future").acts[0]!.numbers[0]!.id).toBe("test-future");
    expect(expanded.datasets.every((item) => !item.productionReady)).toBe(true);
  });
  it("rejects ambiguous IDs, canonical mismatches and escaping paths", () => {
    const { root, registry, show, write } = fixture();
    expect(() => productionPath(root, "../private.json")).toThrow("escapes");
    expect(() => productionPath(root, "/private.json")).toThrow("relative");
    show.id = "another-production";
    write();
    expect(() => loadProductionCatalog(root)).toThrow("registered production");
    show.id = "test-production";
    registry.productions[0]!.numbers.push(registry.productions[0]!.numbers[0]!);
    write();
    expect(() => loadProductionCatalog(root)).toThrow("ambiguous");
  });
});
