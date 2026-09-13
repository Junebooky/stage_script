import { demoShow, parseShow, type Show } from "@stage/script-schema";

const SHOW_KEY = "cueflow-canonical-show-v1";

export function readSelectedShow(fallback: Show): Show {
  try {
    const raw = localStorage.getItem(SHOW_KEY);
    if (raw) {
      const saved = parseShow(JSON.parse(raw));
      // Ignore only the old bundled synthetic default, never a user's edited show.
      if (JSON.stringify(saved) !== JSON.stringify(parseShow(demoShow))) return saved;
    }
  } catch { /* Invalid stored imports never override the bundled canonical script. */ }
  return fallback;
}

export function storeSelectedShow(show: Show): boolean {
  const serialized = JSON.stringify(parseShow(show));
  try { localStorage.setItem(SHOW_KEY, serialized); return true; }
  catch { return false; } // Storage can be disabled/full; the current session still works.
}
