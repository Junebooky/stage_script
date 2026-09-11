import type { StreamingHypothesis } from "@stage/alignment";

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: { transcript: string; confidence: number };
}

interface SpeechRecognitionEventLike extends Event {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike extends Event {
  error: string;
}

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  }
}

export interface StreamingASRAdapter {
  readonly name: string;
  readonly available: boolean;
  start(): void;
  stop(): void;
}

export class BrowserSpeechASRAdapter implements StreamingASRAdapter {
  readonly name = "Browser interim ASR";
  private recognition: SpeechRecognitionLike | null = null;
  private shouldRestart = false;
  private active = false;

  constructor(
    private readonly onHypothesis: (hypothesis: StreamingHypothesis) => void,
    private readonly onStatus: (status: "idle" | "listening" | "error") => void
  ) {
    if (typeof window === "undefined") return;
    const Constructor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
    if (!Constructor) return;
    this.recognition = new Constructor();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = "ko-KR";
    this.recognition.maxAlternatives = 1;
    this.bindEvents();
  }

  get available(): boolean {
    return this.recognition !== null;
  }

  start(): void {
    if (!this.recognition || this.active) return;
    this.shouldRestart = true;
    try {
      this.recognition.start();
    } catch {
      // A redundant start can throw while the browser is transitioning states.
    }
  }

  stop(): void {
    this.shouldRestart = false;
    this.active = false;
    this.recognition?.stop();
    this.onStatus("idle");
  }

  private bindEvents(): void {
    if (!this.recognition) return;
    this.recognition.onstart = () => {
      this.active = true;
      this.onStatus("listening");
    };
    this.recognition.onresult = (event) => {
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const alternative = result?.[0];
        if (!result || !alternative?.transcript.trim()) continue;
        this.onHypothesis({
          text: alternative.transcript.trim(),
          confidence: alternative.confidence || (result.isFinal ? 0.9 : 0.82),
          isFinal: result.isFinal,
          receivedAt: performance.now(),
          speechActive: true
        });
      }
    };
    this.recognition.onerror = (event) => {
      if (event.error !== "no-speech" && event.error !== "aborted") this.onStatus("error");
    };
    this.recognition.onend = () => {
      this.active = false;
      if (this.shouldRestart) {
        window.setTimeout(() => {
          if (!this.shouldRestart) return;
          try {
            this.recognition?.start();
          } catch {
            this.onStatus("error");
          }
        }, 180);
      } else {
        this.onStatus("idle");
      }
    };
  }
}

