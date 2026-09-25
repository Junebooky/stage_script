import { OperatorExperience } from "@/components/OperatorExperience";
import { loadProductionCatalog, requireCanonical } from "@stage/script-schema/production";
import { buildRecordingReplayScript, validateRecordingReference, validateRecordingReplayProfile } from "@stage/rehearsal";
import profile from "../../../../data/replay-recordings/R001-M05-2.profile.json";
import reference from "../../../../data/replay-recordings/R001-M05-2.reference.json";
import { validateDemoTimeline } from "@/lib/demo-timeline";

export const dynamic = "force-dynamic";

export default function OperatorPage() {
  const catalog = loadProductionCatalog();
  const initialShow = requireCanonical(catalog);
  const script = buildRecordingReplayScript(initialShow, profile);
  // Reference timing is deliberately confined to an explicitly labelled demo.
  // The saved-ASR evaluator and live follower never receive this schedule.
  validateRecordingReference(validateRecordingReplayProfile(initialShow, profile), reference);
  const timeline = validateDemoTimeline({ recordingId: profile.recordingId, script,
    cues: reference.cues.map(({ cueId, referenceStartMs }) => ({ cueId, referenceStartMs })) });
  return <OperatorExperience initialShow={initialShow} catalog={catalog} timeline={timeline} />;
}
