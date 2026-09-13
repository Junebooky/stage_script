"use client";

import type { Show } from "@stage/script-schema";
import type { ProductionCatalog } from "@stage/script-schema/production-types";

export function ProductionSelector({ catalog, show, disabled, onSelect }: { catalog: ProductionCatalog; show: Show; disabled?: boolean; onSelect: (show: Show) => void }) {
  const numbers = show.acts.flatMap((act) => act.numbers);
  const selected = catalog.datasets.find((item) => item.productionId === show.id && numbers.length === 1 && item.id === numbers[0]?.id);
  return <label className="production-selector">실제 공연 데이터 <select aria-label="Production number" value={selected?.id ?? "custom"} disabled={disabled} onChange={(event) => {
    const dataset = catalog.datasets.find((item) => item.id === event.target.value);
    if (dataset?.show) onSelect(structuredClone(dataset.show));
  }}>
    {!selected ? <option value="custom">사용자가 불러온 확정 대본</option> : null}
    {catalog.datasets.map((item) => <option key={item.id} value={item.id} disabled={!item.show}>{item.id} · {item.title}{item.show ? "" : " · CANONICAL SCRIPT REQUIRED"}</option>)}
  </select><small>{selected ? "REAL CANONICAL · 공연 승인 / ASR 검증 전" : "IMPORTED CANONICAL"}</small></label>;
}
