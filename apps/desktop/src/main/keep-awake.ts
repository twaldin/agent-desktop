export interface KeepAwakePolicy { requested: boolean; remoteAccessEnabled: boolean }
export interface KeepAwakeStatus {
  supported: boolean;
  active: boolean;
  onBattery?: boolean;
  error?: string;
}
interface PowerAdapter {
  supported: boolean;
  onBattery(): boolean;
  start(type: "prevent-app-suspension"): number;
  stop(id: number): boolean;
  isStarted(id: number): boolean;
}

/** One desktop-process owner, independent of renderer/window lifetimes. Only
 * committed local-host policy can request a blocker; stale reads never enable it. */
export class KeepAwake {
  private connected = false;
  private disposed = false;
  private generation = 0;
  private policy?: KeepAwakePolicy;
  private blocker?: number;
  private error?: string;
  private onBattery?: boolean;
  private inFlight?: Promise<void>;
  private again = false;
  constructor(private power: PowerAdapter, private read: () => Promise<KeepAwakePolicy>, private changed: () => void) {}

  status(): KeepAwakeStatus {
    return { supported: this.power.supported, active: this.blocker !== undefined,
      ...(this.onBattery === undefined ? {} : { onBattery: this.onBattery }), ...(this.error ? { error: this.error } : {}) };
  }
  connection(connected: boolean) {
    this.connected = connected;
    this.invalidate();
  }
  invalidate() {
    this.generation++;
    this.policy = undefined;
    this.sync();
    if (this.connected && !this.disposed && this.power.supported) void this.refresh();
  }
  refresh(): Promise<void> {
    if (this.inFlight) { this.again = true; return this.inFlight; }
    if (!this.connected || this.disposed || !this.power.supported) return Promise.resolve();
    const generation = this.generation;
    this.inFlight = (async () => {
      try {
        const policy = await this.read();
        if (generation !== this.generation || !this.connected || this.disposed) return;
        if (typeof policy.requested !== "boolean" || typeof policy.remoteAccessEnabled !== "boolean") throw new Error("Invalid keep-awake policy.");
        this.policy = policy; this.error = undefined;
      } catch (cause) {
        if (generation !== this.generation || this.disposed) return;
        this.policy = undefined; this.error = message(cause);
      } finally { if (generation === this.generation && !this.disposed) this.sync(); }
    })().finally(() => {
      this.inFlight = undefined;
      if (this.again) { this.again = false; void this.refresh(); }
    });
    return this.inFlight;
  }
  powerChanged() { this.sync(); }
  dispose() {
    this.disposed = true; this.connected = false; this.generation++; this.policy = undefined;
    this.sync();
  }
  private sync() {
    // A failed power query must not retain a blocker using an old AC reading.
    try { this.onBattery = this.power.supported ? this.power.onBattery() : undefined; }
    catch (cause) { this.onBattery = undefined; this.error = message(cause); }
    try {
      const desired = !this.disposed && this.connected && this.power.supported && this.policy?.requested
        && this.policy.remoteAccessEnabled && this.onBattery === false;
      if (this.blocker !== undefined && !this.power.isStarted(this.blocker)) this.blocker = undefined;
      if (!desired && this.blocker !== undefined) {
        const id = this.blocker;
        this.power.stop(id);
        if (this.power.isStarted(id)) throw new Error("The system sleep-prevention request could not be released.");
        this.blocker = undefined;
      }
      if (desired && this.blocker === undefined) {
        const id = this.power.start("prevent-app-suspension");
        if (!this.power.isStarted(id)) throw new Error("The system did not accept the sleep-prevention request.");
        this.blocker = id;
      }
    } catch (cause) { this.error = message(cause); }
    this.changed();
  }
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
