import { OperatorExperience } from "@/components/OperatorExperience";
import { loadProductionCatalog, requireCanonical } from "@stage/script-schema/production";

export const dynamic = "force-dynamic";

export default function OperatorPage() {
  const catalog = loadProductionCatalog();
  return <OperatorExperience initialShow={requireCanonical(catalog)} catalog={catalog} />;
}
