import type { CueProfile } from "@stage/script-schema";
import type { ConfidenceBasis } from "@stage/alignment";

export interface TimestampedWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence: number | null;
  confidenceBasis?: ConfidenceBasis;
}
export interface TimestampedASR extends TimestampedWord {
  id: string;
  words?: TimestampedWord[];
  providerMetadata?: { avg_logprob?: number; no_speech_prob?: number; wordTimingWarning?: string; [key: string]: unknown };
  /** If absent, replay models delivery at ASR span end, not measured inference time. */
  receivedAtMs?: number;
}
export type ReviewStatus = "accepted" | "warning" | "review-required";
export interface CueObservation {
  id: string;
  cueId: string;
  actId: string;
  numberId: string;
  startMs: number;
  endMs: number;
  asrText: string;
  alignmentConfidence: number;
  reviewStatus: ReviewStatus;
  groundTruth: "pseudo" | "human";
  anchors: string[];
  previousCueId: string | null;
  relativeAfterPreviousMs: number | null;
  gapBeforeMs: number;
  collisionRisk: number;
  matchScore?: number;
  normalizedMatchRange?: [number, number];
  transcriptId?: string;
  asrConfidence?: number | null;
  asrConfidenceBasis?: ConfidenceBasis;
  alignmentEvidenceBasis?: "text-sequence-only" | "text-sequence-and-asr";
  timingBasis?: "asr-word-estimate" | "asr-span-interpolation" | "human-confirmed";
  timingReliable?: boolean;
  repetition?: { competingCueIds: string[]; resolvedBy: "sequence-context" | "unresolved" | "unique-text" };
  imageDurationMs?: number;
  reviewer?: string;
}
export interface NumberRegion {
  actId: string;
  numberId: string;
  startMs: number;
  endMs: number;
  confidence: number;
  occurrence: number;
  transition: "start" | "ordered" | "skip" | "restart";
}
export interface ReviewItem {
  id: string;
  observationId: string | null;
  cueId: string | null;
  transcriptId: string | null;
  reason: string;
  startMs: number | null;
}
export interface ReplayControl {
  atMs: number;
  type: "manual-next" | "manual-previous" | "resync" | "hold" | "resume";
  actId: string;
}
export interface RehearsalAnalysis {
  version: 1;
  rehearsalId: string;
  showId: string;
  canonicalFingerprint: string;
  createdAt: number;
  revision?: number;
  timestampBasis: "local-asr-pseudo" | "cloud-asr-pseudo";
  asrProvider?: string;
  model?: string;
  alignmentMode?: "known-number-local" | "whole-show-global";
  numberId?: string;
  transcript: TimestampedASR[];
  observations: CueObservation[];
  numberRegions: NumberRegion[];
  skippedCueIds: string[];
  skippedNumberIds: string[];
  reviewQueue: ReviewItem[];
  controls: ReplayControl[];
  reviewDecisions?: { reviewItemId: string; reviewer: string; reason: string; decision: "excluded-from-evaluation"; at: number }[];
}
export interface AnalysisOptions {
  rehearsalId: string;
  timestampBasis?: RehearsalAnalysis["timestampBasis"];
  asrProvider?: string;
  model?: string;
  acceptedThreshold?: number;
  warningThreshold?: number;
  minimumAlignmentScore?: number;
  now?: number;
}
export interface ReplayTrigger {
  cueId: string;
  atMs: number;
  source: "automatic" | "fallback" | "manual";
  image?: boolean;
}
export interface ReplayMetrics {
  cueAccuracy: number;
  evaluatedCues: number;
  missedCues: number;
  wrongTriggers: number;
  earlyTriggers: number;
  lateTriggers: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  recoveryTimeMs: number | null;
  manualInterventions: number;
  fallbackTriggers: number;
  imageEntryErrorMs: number | null;
  imageExitErrorMs: number | null;
  reviewRequired: number;
  humanConfirmedCues: number;
  pseudoGroundTruthCues: number;
  excludedRegions: number;
  timestampBasis: "simulated-asr-delivery" | "recorded-asr-delivery";
}
export interface ReplayReport {
  rehearsalId: string;
  triggers: ReplayTrigger[];
  metrics: ReplayMetrics;
}
export interface ChallengerEvaluation {
  recommended: boolean;
  reasons: string[];
  evidence: "pseudo" | "human" | "mixed";
  replays: { rehearsalId: string; analysisCreatedAt: number; analysisRevision: number; champion: ReplayMetrics; challenger: ReplayMetrics }[];
  policy: { requireAllHistorical: true; allowRegression: false; operatorConfirmationRequired: true };
}
export interface ProfileCandidate {
  id: string;
  showId: string;
  numberId?: string;
  championId: string | null;
  canonicalFingerprint: string;
  profiles: CueProfile[];
  evaluation: ChallengerEvaluation;
  createdAt: number;
  promoted: boolean;
}
