import { RehearsalWorkspace } from "@/components/RehearsalWorkspace";
import { loadProductionCatalog, requireCanonical } from "@stage/script-schema/production";

export const dynamic = "force-dynamic";

export default function RehearsalPage() {
  const catalog = loadProductionCatalog();
  return <RehearsalWorkspace initialShow={requireCanonical(catalog)} catalog={catalog} />;
}
