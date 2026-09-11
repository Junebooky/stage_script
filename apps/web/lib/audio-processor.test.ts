import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../public/audio-processor.js", import.meta.url), "utf8");
function setup(sampleRate: number) {
  const messages: Array<{ type: string; pcm?: Float32Array; level?: number }> = [];
  let Processor: new () => { process(inputs: Float32Array[][]): boolean };
  runInNewContext(source, {
    sampleRate,
    AudioWorkletProcessor: class { port = { postMessage: (message: typeof messages[number]) => messages.push(message) }; },
    registerProcessor: (_: string, ctor: typeof Processor) => { Processor = ctor; }
  });
  return { messages, processor: new Processor!() };
}

describe("AudioWorklet capture", () => {
  it.each([44100, 48000])("emits exactly 50 20-ms frames per second at %i Hz", (sampleRate) => {
    const { processor, messages } = setup(sampleRate);
    for (let index = 0; index < sampleRate; index += 128) {
      processor.process([[new Float32Array(Math.min(128, sampleRate - index)).fill(0.1)]]);
    }
    const chunks = messages.filter((message) => message.type === "audio");
    expect(chunks).toHaveLength(50);
    expect(chunks.every((chunk) => chunk.pcm?.length === 320)).toBe(true);
    expect(chunks.at(-1)?.level).toBeGreaterThan(0);
  });
  it("reports speech onset and end and returns the meter to zero during silence", () => {
    const { processor, messages } = setup(16000);
    for (let index = 0; index < 20; index++) processor.process([[new Float32Array(128).fill(0.1)]]);
    for (let index = 0; index < 80; index++) processor.process([[new Float32Array(128)]]);
    expect(messages.filter((message) => message.type === "speech-start")).toHaveLength(1);
    expect(messages.filter((message) => message.type === "speech-end")).toHaveLength(1);
    expect(messages.at(-1)?.level).toBe(0);
  });
});
