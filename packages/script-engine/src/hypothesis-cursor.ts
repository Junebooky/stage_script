/** Tracks consumed *recognition evidence*, never a verbatim full script sentence. */
export class HypothesisCursor {
  private id = "";
  text = "";
  floor = 0;
  private cueStart: number | null = null;
  private expected = "";
  private checkpointed = false;

  get hasCue(): boolean { return this.cueStart !== null; }

  reset() {
    this.id = "";
    this.text = "";
    this.floor = 0;
    this.cueStart = null;
    this.expected = "";
    this.checkpointed = false;
  }

  discard() {
    // Keep the live stream checkpoint: Reset must not replay its old transcript.
    this.floor = this.text.length;
    this.cueStart = null;
    this.expected = "";
    this.checkpointed = true;
  }

  update(id: string, text: string): boolean {
    if (id !== this.id) {
      this.reset();
      this.id = id;
    } else if (text === this.text) {
      return false;
    }
    let prefix = 0;
    while (prefix < Math.min(this.text.length, text.length) && this.text[prefix] === text[prefix]) prefix += 1;
    let suffix = 0;
    while (suffix < Math.min(this.text.length, text.length) - prefix && this.text[this.text.length - 1 - suffix] === text[text.length - 1 - suffix]) suffix += 1;

    if (this.checkpointed && prefix < this.floor) {
      // A late rewrite of checkpointed cumulative speech is not fresh evidence.
      // Be conservative after operator navigation: discard that revision in full.
      this.floor = text.length;
      this.text = text;
      return true;
    }

    if (prefix < 2 && this.cueStart !== null && !text.startsWith(this.expected.slice(0, 2))) {
      // Some adapters roll over the text without changing result ID.
      this.floor = 0;
      this.cueStart = null;
      this.expected = "";
    } else {
      const anchor = this.cueStart === null ? "" : this.text.slice(this.cueStart, this.floor);
      let relocated = -1;
      if (anchor.length >= 2 && prefix < this.floor && this.cueStart !== null) {
        for (let candidate = text.indexOf(anchor, Math.max(0, this.cueStart - 64)); candidate >= 0 && candidate <= this.cueStart + 64; candidate = text.indexOf(anchor, candidate + 1)) {
          if (relocated < 0 || Math.abs(candidate - this.cueStart) < Math.abs(relocated - this.cueStart)) relocated = candidate;
        }
      }
      const remap = (position: number) => {
        if (position <= prefix) return position;
        if (suffix > 0 && position >= this.text.length - suffix) return Math.max(prefix, position + text.length - this.text.length);
        return Math.min(position, text.length);
      };
      if (relocated >= 0) {
        this.cueStart = relocated;
        this.floor = relocated + anchor.length;
      } else {
        this.floor = remap(this.floor);
        if (this.cueStart !== null) this.cueStart = remap(this.cueStart);
      }
    }
    this.text = text;
    return true;
  }

  isCurrentLine(start: number, end: number): boolean {
    if (this.cueStart === null || start < this.cueStart) return false;
    return this.expected.startsWith(this.text.slice(this.cueStart, end));
  }

  consume(start: number, end: number, expected: string) {
    this.checkpointed = false;
    this.cueStart = start;
    this.floor = end;
    this.expected = expected;
  }
}
