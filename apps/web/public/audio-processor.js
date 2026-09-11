class CaptionAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.chunkSize = 320;
    this.pending = [];
    this.speechActive = false;
    this.quietFrames = 0;
    this.resamplePhase = 0;
    this.resampleSum = 0;
    this.resampleCount = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel?.length) return true;
    // Preserve resampling phase across 128-frame render quanta. Resetting it for
    // every quantum produces the wrong sample count at both 44.1 and 48 kHz.
    for (let index = 0; index < channel.length; index += 1) {
      this.resampleSum += channel[index];
      this.resampleCount += 1;
      this.resamplePhase += this.targetRate;
      if (this.resamplePhase >= sampleRate) {
        this.pending.push(this.resampleSum / this.resampleCount);
        this.resamplePhase -= sampleRate;
        this.resampleSum = 0;
        this.resampleCount = 0;
      }
    }

    while (this.pending.length >= this.chunkSize) {
      const pcm = new Float32Array(this.pending.splice(0, this.chunkSize));
      let squareSum = 0;
      let low = 0;
      let mid = 0;
      let high = 0;
      for (let index = 0; index < pcm.length; index += 1) {
        const value = pcm[index];
        squareSum += value * value;
        const delta = Math.abs(value - (pcm[index - 1] ?? 0));
        low += Math.abs(value);
        mid += delta;
        high += Math.abs(delta - Math.abs((pcm[index - 1] ?? 0) - (pcm[index - 2] ?? 0)));
      }
      const level = Math.sqrt(squareSum / pcm.length);
      if (level > 0.018) {
        this.quietFrames = 0;
        if (!this.speechActive) {
          this.speechActive = true;
          this.port.postMessage({ type: "speech-start" });
        }
      } else if (this.speechActive) {
        this.quietFrames += 1;
        if (this.quietFrames >= 24) {
          this.speechActive = false;
          this.quietFrames = 0;
          this.port.postMessage({ type: "speech-end" });
        }
      }
      this.port.postMessage(
        {
          type: "audio",
          pcm,
          level: Math.min(1, level * 12),
          low: Math.min(1, (low / pcm.length) * 14),
          mid: Math.min(1, (mid / pcm.length) * 20),
          high: Math.min(1, (high / pcm.length) * 28)
        },
        [pcm.buffer]
      );
    }
    return true;
  }
}

registerProcessor("caption-audio-processor", CaptionAudioProcessor);
