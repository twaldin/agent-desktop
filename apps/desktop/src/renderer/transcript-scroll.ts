export interface TranscriptReadingPosition {
  following: boolean;
  scrollTop: number;
  anchor?: { messageId: string; path: number[]; offset: number };
}

/** Coordinates one real scroll viewport. Message content is never stored here. */
export class TranscriptViewport {
  private position: TranscriptReadingPosition;
  private expectedTop?: number;
  private frame = 0;
  private disposed = false;
  private geometry = "";
  private inputPending = false;
  private inputFrame = 0;
  private resize: ResizeObserver;
  private mutations: MutationObserver;

  constructor(private viewport: HTMLElement, private content: HTMLElement, initial: TranscriptReadingPosition | undefined,
    private changed: (position: TranscriptReadingPosition) => void) {
    this.position = initial ?? { following: true, scrollTop: 0 };
    this.geometry = this.dimensions();
    viewport.addEventListener("scroll", this.onScroll, { passive: true });
    for (const type of ["wheel", "touchmove", "pointerdown", "keydown"]) viewport.addEventListener(type, this.onInput, { passive: true });
    this.resize = new ResizeObserver(this.refresh);
    this.resize.observe(viewport); this.resize.observe(content);
    this.mutations = new MutationObserver(this.refresh);
    this.mutations.observe(content, { subtree: true, childList: true, characterData: true, attributes: true });
    this.restore();
  }

  refresh = () => {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.restore(); });
  };

  latest() {
    this.position = { following: true, scrollTop: this.viewport.scrollTop };
    this.restore(); this.changed(this.position);
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.inputFrame);
    this.resize.disconnect(); this.mutations.disconnect();
    this.viewport.removeEventListener("scroll", this.onScroll);
    for (const type of ["wheel", "touchmove", "pointerdown", "keydown"]) this.viewport.removeEventListener(type, this.onInput);
  }

  private dimensions() { return `${this.viewport.clientWidth}:${this.viewport.clientHeight}:${this.viewport.scrollHeight}`; }
  private onInput = (event: Event) => {
    if (event.type === "pointerdown" && event.target !== this.viewport) return;
    if (event instanceof KeyboardEvent && !["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) return;
    this.inputPending = true;
    cancelAnimationFrame(this.inputFrame);
    // Input may precede a streamed layout change before the browser delivers its
    // scroll event. Keep that intent through the next frame, then expire gestures
    // consumed by a nested scroller or an already-reached edge.
    this.inputFrame = requestAnimationFrame(() => {
      this.inputFrame = requestAnimationFrame(() => { this.inputPending = false; this.inputFrame = 0; });
    });
  };

  private onScroll = () => {
    // Ignore only our exact correction. Wheel, keyboard, scrollbar and anchor-link
    // navigation remain authoritative even when an observer correction is pending.
    if (this.expectedTop !== undefined && Math.abs(this.viewport.scrollTop - this.expectedTop) < 1) return;
    this.expectedTop = undefined;
    if (!this.content.querySelector("[data-message-id]")) return; // A reconnect may temporarily render no rows.
    const geometry = this.dimensions();
    // Chromium emits a scroll event when a smaller document clamps scrollTop.
    // That is layout correction, not a reader choosing to follow the latest turn.
    if (geometry !== this.geometry && !this.inputPending) { this.refresh(); return; }
    this.geometry = geometry; this.inputPending = false; cancelAnimationFrame(this.inputFrame); this.inputFrame = 0;
    this.position = this.capture(this.viewport.scrollHeight - this.viewport.clientHeight - this.viewport.scrollTop < 24);
    this.changed(this.position);
  };

  private restore() {
    if (!this.viewport.clientHeight || !this.content.querySelector("[data-message-id]")) return;
    if (this.inputPending) { this.refresh(); return; }
    let top = this.position.following ? this.viewport.scrollHeight - this.viewport.clientHeight : this.position.scrollTop;
    if (!this.position.following && this.position.anchor) {
      const anchor = this.position.anchor;
      const row = [...this.content.querySelectorAll<HTMLElement>("[data-message-id]")].find(row => row.dataset.messageId === anchor.messageId);
      if (row) {
        let target: Element = row;
        for (const index of anchor.path) { if (!target.children[index]) { target = row; break; } target = target.children[index]!; }
        top = this.viewport.scrollTop + target.getBoundingClientRect().top - this.viewport.getBoundingClientRect().top - anchor.offset;
      }
    }
    this.viewport.scrollTop = Math.max(0, top);
    this.expectedTop = this.viewport.scrollTop;
    this.geometry = this.dimensions();
    // Retain the reading anchor while it is absent during cache/live replacement.
    this.position = { ...this.position, scrollTop: this.viewport.scrollTop };
    this.changed(this.position);
  }

  private capture(following: boolean): TranscriptReadingPosition {
    const position: TranscriptReadingPosition = { following, scrollTop: this.viewport.scrollTop };
    if (following) return position;
    const edge = this.viewport.getBoundingClientRect().top;
    const rows = [...this.content.querySelectorAll<HTMLElement>("[data-message-id]")];
    // Rows are in native chronological DOM order. Binary search avoids measuring
    // every historical row on each reading-position update.
    let lower = 0, upper = rows.length;
    while (lower < upper) { const middle = (lower + upper) >>> 1; if (rows[middle]!.getBoundingClientRect().bottom <= edge) lower = middle + 1; else upper = middle; }
    const row = rows[Math.min(lower, rows.length - 1)];
    if (!row) return position;
    let target: Element = row;
    // A paragraph/code/list anchor survives width/font changes in a long message
    // better than an absolute offset from the beginning of that entire message.
    for (const item of row.querySelectorAll("p, pre, li, blockquote, h1, h2, h3, h4, h5, h6, table, .transcript-activity-header")) {
      const rect = item.getBoundingClientRect();
      if (rect.height && rect.bottom > edge) { target = item; break; }
    }
    const path: number[] = [];
    for (let item = target; item !== row && item.parentElement; item = item.parentElement) path.unshift([...item.parentElement.children].indexOf(item));
    position.anchor = { messageId: row.dataset.messageId!, path, offset: target.getBoundingClientRect().top - edge };
    return position;
  }
}

/** Bounded, window-local positions. Corrupt/disabled browser storage is harmless. */
export class TranscriptReadingPositions {
  private positions = new Map<string, TranscriptReadingPosition>();
  private timer?: ReturnType<typeof setTimeout>;
  private readonly key = "agent-desktop:transcript-reading:v1";
  constructor(private storage?: Pick<Storage, "getItem" | "setItem">) {
    try {
      const saved: unknown = JSON.parse(storage?.getItem(this.key) ?? "[]");
      if (Array.isArray(saved)) for (const entry of saved.slice(-100)) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || entry[0].length > 400) continue;
        const value = entry[1];
        if (!value || typeof value.following !== "boolean" || !Number.isFinite(value.scrollTop) || value.scrollTop < 0) continue;
        const anchor = value.anchor;
        if (anchor && (typeof anchor.messageId !== "string" || anchor.messageId.length > 400 || !Number.isFinite(anchor.offset) || !Array.isArray(anchor.path) || anchor.path.length > 32 || anchor.path.some((index: unknown) => typeof index !== "number" || !Number.isInteger(index) || index < 0))) continue;
        this.positions.set(entry[0], { following: value.following, scrollTop: value.scrollTop, ...(anchor ? { anchor: { messageId: anchor.messageId, path: anchor.path, offset: anchor.offset } } : {}) });
      }
    } catch { /* Reading still works with private window-local memory. */ }
  }
  get(key: string) { return this.positions.get(key); }
  set(key: string, position: TranscriptReadingPosition) {
    this.positions.delete(key); this.positions.set(key, position);
    while (this.positions.size > 100) this.positions.delete(this.positions.keys().next().value!);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, 150);
  }
  flush = () => {
    clearTimeout(this.timer); this.timer = undefined;
    try { this.storage?.setItem(this.key, JSON.stringify([...this.positions])); } catch { /* In-memory positions remain usable. */ }
  };
}
