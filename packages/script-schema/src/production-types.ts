import type { Show } from "./index";

export interface RegisteredNumber {
  id: string;
  title: string;
  canonicalPath: string;
  rehearsalDirectory: string;
  defaultAudioPath?: string;
  notes?: string;
  productionReady: false;
}
export interface ProductionRegistry {
  version: 1;
  defaultNumberId: string;
  productions: { id: string; title: string; locale: string; numbers: RegisteredNumber[] }[];
}
export interface ProductionDataset extends RegisteredNumber {
  productionId: string;
  show: Show | null;
  status: "CANONICAL READY" | "CANONICAL SCRIPT REQUIRED";
}
export interface ProductionCatalog {
  defaultNumberId: string;
  datasets: ProductionDataset[];
}
