const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function localBackendUrl(path: string, origin = "http://localhost:8000"): string {
  const url = new URL(origin);
  if (!LOOPBACK.has(url.hostname) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("PERFORMANCE LOCAL requires a loopback audio backend");
  return new URL(path, url.origin).toString();
}

export function performanceSocketUrl(configured?: string): string {
  const url = new URL(configured || "ws://localhost:8000/ws/audio");
  if (!LOOPBACK.has(url.hostname) || !["ws:", "wss:"].includes(url.protocol) || url.username || url.password) throw new Error("LOCAL ASR UNAVAILABLE — 공연 모드는 localhost 오디오 엔진만 허용합니다.");
  url.searchParams.set("mode", "performance");
  return url.toString();
}

export async function localRequest<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(localBackendUrl(path), { ...options, signal: options?.signal ?? AbortSignal.timeout(15_000) });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: unknown } | null;
    const detail = body?.detail;
    const reasons = detail && typeof detail === "object" && "reasons" in detail && Array.isArray(detail.reasons) ? detail.reasons.filter((item) => typeof item === "string").join(" · ") : null;
    throw new Error(typeof detail === "string" ? detail : reasons || `Local backend: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export function downloadJSON(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
