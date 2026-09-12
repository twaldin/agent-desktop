import type { DesktopBridge } from "../../../../packages/shared/src/protocol";
import { DEFAULT_SIDEBAR_NAVIGATION, parseSidebarNavigation, SIDEBAR_NAVIGATION_PREFERENCE, type SidebarNavigationPreference } from "../../../../packages/shared/src/sidebar-navigation";
import type { DraftCache } from "./drafts";
import type { OfflineCache } from "./offline-cache";
import { PreferencesState } from "./preferences-state";

/** Uses the shared versioned preference parser, clock and durable command receipt loop.
 * The viewing local host owns writes; changing the selected remote workspace does not.
 * Owner-scoped cache/receipts prevent a reconnect from replaying onto another host. */
export class SidebarNavigationState {
  readonly preferences: PreferencesState;
  private intent?: SidebarNavigationPreference;
  private recoveryError?: string;
  private storageError?: string;
  private loaded = false;
  private supported = false;
  private active = false;
  private listeners = new Set<() => void>();
  private readonly intentKey: string;
  constructor(readonly owner: string, bridge: Pick<DesktopBridge, "getPreferences" | "getPreferencesV2" | "command" | "subscribe">, cache: OfflineCache, private receipts: DraftCache) {
    const prefix = `agent-desktop:sidebar-navigation:${encodeURIComponent(owner)}:`;
    this.intentKey = `${prefix}intent:v1`;
    const checkOwner = () => { if (!this.active) throw new Error("Reconnect to the original local host to load sidebar customization."); };
    this.preferences = new PreferencesState({
      getPreferences: async () => { checkOwner(); const value = await bridge.getPreferences(); checkOwner(); return value; },
      ...(bridge.getPreferencesV2 ? { getPreferencesV2: async () => { checkOwner(); const value = await bridge.getPreferencesV2!(); checkOwner(); return value; } } : {}),
      command: (envelope, hostId) => {
        if (!this.active || !this.supported || hostId !== owner) throw new Error("Reconnect to the original local host with sidebar customization support to save changes.");
        return bridge.command(envelope, owner);
      },
      subscribe: bridge.subscribe.bind(bridge),
    }, { read: key => cache.read(prefix + key), write: (key, value) => cache.write(prefix + key, value) },
    { read: key => receipts.read(prefix + key), write: (key, value) => receipts.write(prefix + key, value) });
    try { const saved = receipts.read(this.intentKey); if (saved && saved !== "null") this.intent = parseSidebarNavigation(JSON.parse(saved)); }
    catch (cause) { this.recoveryError = `Saved sidebar changes could not be recovered. Original bytes were retained. ${String(cause)}`; }
    this.preferences.subscribe(() => this.changed());
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { for (const listener of this.listeners) listener(); }
  get value() { return this.intent ?? this.preferences.get(SIDEBAR_NAVIGATION_PREFERENCE) ?? DEFAULT_SIDEBAR_NAVIGATION; }
  get error() { return this.recoveryError ?? this.storageError ?? this.preferences.error ?? this.preferences.cacheWarning; }
  get unsaved() { return Boolean(this.intent || this.preferences.pending.length); }
  get busy() { return this.preferences.busy; }
  get writable() { return this.active && this.supported && this.loaded && !this.busy && !this.unsaved && !this.recoveryError; }
  get canRetry() { return this.active && this.supported && !this.busy && !this.recoveryError; }
  get unavailable() { return !this.active ? "Reconnect to this device’s host to save sidebar changes." : !this.supported ? "Update this device’s host to save sidebar customization. Your saved choices are retained." : !this.loaded ? "Loading sidebar customization…" : undefined; }
  setConnection(localHostId: string | undefined, connected: boolean, supported: boolean) {
    this.active = localHostId === this.owner && connected;
    this.supported = supported;
    this.preferences.setConnection(this.owner, this.active && supported);
  }
  start() { this.preferences.start(); }
  stop() { this.active = false; this.preferences.setConnection(this.owner, false); this.preferences.stop(); }
  async refresh() {
    await this.preferences.refresh();
    if (!this.preferences.error) this.loaded = true;
    this.changed();
  }
  async save(value: SidebarNavigationPreference) {
    if (!this.writable) return;
    try {
      const next = parseSidebarNavigation(value);
      this.receipts.write(this.intentKey, JSON.stringify(next));
      this.intent = next;
      this.storageError = undefined;
      this.changed();
      await this.retry();
    } catch (cause) { this.storageError = `Sidebar changes could not be saved: ${String(cause)}`; this.changed(); }
  }
  async retry() {
    if (!this.canRetry) return;
    try {
      this.storageError = undefined;
      if (this.preferences.pending.length) await this.preferences.retry();
      else if (this.intent) await this.preferences.put({ key: SIDEBAR_NAVIGATION_PREFERENCE, value: this.intent });
      else await this.refresh();
      if (!this.preferences.pending.length && !this.preferences.error && this.intent) {
        this.receipts.write(this.intentKey, "null");
        this.intent = undefined;
      }
    } catch (cause) { this.storageError = `Sidebar changes could not be saved: ${String(cause)}`; }
    this.changed();
  }
}
