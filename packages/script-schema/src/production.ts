/** Server/CLI only. Browser components receive serializable catalog data as props. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseShow, type Show } from "./index";
import type { ProductionCatalog, ProductionRegistry } from "./production-types";

export function productionRoot(start = process.cwd()): string {
  let current = resolve(start);
  while (!existsSync(resolve(current, "data/productions/registry.json"))) {
    const parent = dirname(current);
    if (parent === current) throw new Error("Production registry not found");
    current = parent;
  }
  return current;
}

export function productionPath(root: string, path: string): string {
  if (!path || isAbsolute(path)) throw new Error("Registry paths must be workspace-relative");
  const base = realpathSync(root);
  const target = resolve(base, path);
  const inside = (value: string) => { const part = relative(base, value); return part !== ".." && !part.startsWith("../") && !isAbsolute(part); };
  if (!inside(target)) throw new Error("Registry path escapes workspace");
  // Resolve existing ancestors too: a missing future canonical file may be
  // beneath a symlink. macOS /var → /private/var is a valid workspace alias.
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  if (!inside(realpathSync(ancestor))) throw new Error("Registry path escapes workspace");
  return target;
}

export function loadProductionCatalog(root = productionRoot()): ProductionCatalog {
  const registry = JSON.parse(readFileSync(resolve(root, "data/productions/registry.json"), "utf8")) as ProductionRegistry;
  if (registry.version !== 1 || !registry.defaultNumberId || !Array.isArray(registry.productions)) throw new Error("Invalid production registry");
  const ids = new Set<string>();
  const datasets = registry.productions.flatMap((production) => {
    if (!production.id || !production.title || !production.locale || !Array.isArray(production.numbers)) throw new Error("Invalid registered production");
    return production.numbers.map((number) => {
      if (!number.id || !number.title || ids.has(number.id)) throw new Error("Missing or ambiguous registered number ID");
      ids.add(number.id);
      const path = productionPath(root, number.canonicalPath);
      productionPath(root, number.rehearsalDirectory);
      if (number.defaultAudioPath) productionPath(root, number.defaultAudioPath);
      const show = existsSync(path) ? parseShow(JSON.parse(readFileSync(path, "utf8"))) : null;
      const numbers = show?.acts.flatMap((act) => act.numbers) ?? [];
      if (show && (show.id !== production.id || numbers.length !== 1 || numbers[0]?.id !== number.id)) throw new Error("Canonical file must describe the registered production and exactly its number");
      return { ...number, productionId: production.id, productionReady: false as const, show,
        status: show ? "CANONICAL READY" as const : "CANONICAL SCRIPT REQUIRED" as const };
    });
  });
  if (!ids.has(registry.defaultNumberId)) throw new Error("Registry default number is not registered");
  return { defaultNumberId: registry.defaultNumberId, datasets };
}

export function requireCanonical(catalog: ProductionCatalog, numberId = catalog.defaultNumberId): Show {
  const dataset = catalog.datasets.find((item) => item.id === numberId);
  if (!dataset?.show) throw new Error(`CANONICAL SCRIPT REQUIRED: ${numberId}`);
  return structuredClone(dataset.show);
}
