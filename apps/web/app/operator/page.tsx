import { OperatorExperience } from "@/components/OperatorExperience";
import { loadProductionCatalog, requireCanonical } from "@stage/script-schema/production";
import { loadDemoRecordings } from "@/lib/demo-recordings";

export const dynamic = "force-dynamic";

export default function OperatorPage() {
  const catalog = loadProductionCatalog();
  const initialShow = requireCanonical(catalog);
  // Reference timing is deliberately confined to an explicitly labelled demo.
  // The saved-ASR evaluator and live follower never receive this schedule.
  return <OperatorExperience initialShow={initialShow} catalog={catalog} recordings={loadDemoRecordings()} />;
}
