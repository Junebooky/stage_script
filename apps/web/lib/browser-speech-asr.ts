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

export type ASRStatus = "idle" | "starting" | "listening" | "error" | "unavailable";

export function speechRecognitionErrorMessage(error: string): string {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
      return "음성 인식 권한이 차단되었습니다. 브라우저 권한을 확인하고 다시 켜주세요.";
    case "network":
      return "음성 인식 서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 마이크를 다시 켜주세요.";
    case "audio-capture":
      return "음성 인식기가 마이크에 접근하지 못했습니다. 입력 장치를 확인해주세요.";
    case "language-not-supported":
      return "이 브라우저의 음성 인식기가 한국어를 지원하지 않습니다.";
    default:
      return "음성 인식을 시작하지 못했습니다. Chrome에서 마이크를 다시 켜주세요.";
  }
}

export class BrowserSpeechASRAdapter implements StreamingASRAdapter {
  readonly name = "Browser interim ASR";
  private recognition: SpeechRecognitionLike | null = null;
  private shouldRestart = false;
  private active = false;
  private starting = false;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private session = 0;
  private finalized = new Set<number>();
  private resultText = new Map<number, string>();

  constructor(
    private readonly onHypothesis: (hypothesis: StreamingHypothesis) => void,
    private readonly onStatus: (status: ASRStatus, detail?: string) => void
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
    if (!this.recognition) {
      this.onStatus("unavailable", "이 브라우저는 음성 인식을 지원하지 않습니다. Chrome에서 열어주세요.");
      return;
    }
    if (this.active || this.starting) return;
    this.shouldRestart = true;
    this.starting = true;
    this.onStatus("starting");
    try {
      this.recognition.start();
    } catch {
      this.fail("start-failed");
    }
  }

  stop(): void {
    this.shouldRestart = false;
    this.active = false;
    this.starting = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    try { this.recognition?.abort(); } catch { /* Already stopped. */ }
    this.onStatus("idle");
  }

  private fail(error: string): void {
    this.shouldRestart = false;
    this.starting = false;
    this.active = false;
    this.onStatus("error", speechRecognitionErrorMessage(error));
  }

  private bindEvents(): void {
    if (!this.recognition) return;
    this.recognition.onstart = () => {
      if (!this.shouldRestart) return;
      this.active = true;
      this.starting = false;
      this.session += 1;
      this.finalized.clear();
      this.resultText.clear();
      this.onStatus("listening");
    };
    this.recognition.onresult = (event) => {
      if (!this.shouldRestart) return;
      for (const index of this.resultText.keys()) {
        if (index >= event.results.length) this.resultText.delete(index);
      }
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        if (this.finalized.has(index)) continue;
        const result = event.results[index];
        const alternative = result?.[0];
        if (!result || !alternative?.transcript.trim()) continue;
        this.resultText.set(index, alternative.transcript.trim());
        if (result.isFinal) this.finalized.add(index);
        this.onHypothesis({
          utteranceId: `browser-${this.session}-${index}`,
          streamId: `browser-session-${this.session}`,
          // A result boundary is not necessarily a word boundary (e.g. 어 + 둠).
          // Do not insert a space that makes a real syllable look like a filler.
          contextText: [...this.resultText.entries()].filter(([position]) => position <= index).sort(([left], [right]) => left - right).map(([, text]) => text).join(""),
          text: alternative.transcript.trim(),
          confidence: alternative.confidence || (result.isFinal ? 0.9 : 0.82),
          isFinal: result.isFinal,
          receivedAt: performance.now(),
          speechActive: true
        });
      }
    };
    this.recognition.onerror = (event) => {
      if (!this.shouldRestart) return;
      if (event.error !== "no-speech" && event.error !== "aborted") this.fail(event.error);
    };
    this.recognition.onend = () => {
      this.active = false;
      this.starting = false;
      if (this.shouldRestart) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.shouldRestart) return;
          this.start();
        }, 40);
      }
    };
  }
}
