import { expect, it } from "vitest";
import { loadDemoRecordings } from "./demo-recordings";

it("validates registered canonical hashes and keeps M05-2 default alongside all 26 M06 cues", () => {
  const recordings = loadDemoRecordings();
  expect(recordings.map((recording) => recording.recordingId)).toEqual(["R001-M05-2", "R001-M06"]);
  expect(recordings[0]!.cues).toHaveLength(27);
  const m06 = recordings[1]!;
  expect(m06.canonicalCueCount).toBe(26);
  expect(m06.cues.map((cue) => cue.cueId)).toEqual(Array.from({ length: 26 }, (_, index) => `M06_C${String(index + 1).padStart(3, "0")}`));
  expect(m06.durationMs).toBe(136000);
  expect(m06.defaultAudioSource).toBe("registered");
  expect(m06.cues[1]!.referenceStartMs).toBe(5460);
  expect(m06.cues[10]!.referenceStartMs).toBe(59880);
  expect(JSON.parse(JSON.stringify(recordings))).toEqual(recordings);
});
