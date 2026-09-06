import type { DesktopBridge, LocalEnvironmentCatalogItem, WorkspaceQueryResult } from "@agent-desktop/shared";
import type { OfflineCache } from "./offline-cache";

type Bridge = Pick<DesktopBridge, "workspaceQuery" | "subscribe">;
export type EnvironmentCatalogItem =
  | { type: "environment"; configPath: string; revision: string; environment: { name: string } }
  | { type: "error"; configPath: string; revision?: string; error: string };
type Cached = { version: 1; hostId: string; projectId: string; items: EnvironmentCatalogItem[] };
const revisionPattern = /^[a-f0-9]{64}$/;

function summary(value: unknown): EnvironmentCatalogItem {
  if (!value || typeof value !== "object") throw new Error("Invalid cached environment item.");
  const candidate = value as Partial<LocalEnvironmentCatalogItem>;
  if (typeof candidate.configPath !== "string" || !candidate.configPath.startsWith("/")) throw new Error("Invalid cached environment path.");
  if (candidate.type === "error") {
    if (typeof candidate.error !== "string") throw new Error("Invalid cached environment error.");
    return { type: "error", configPath: candidate.configPath, error: candidate.error, ...(candidate.revision && revisionPattern.test(candidate.revision) ? { revision: candidate.revision } : {}) };
  }
  if (candidate.type !== "environment" || !revisionPattern.test(candidate.revision ?? "") || !candidate.environment || typeof candidate.environment !== "object") throw new Error("Invalid cached environment entry.");
  const name = (candidate.environment as { name?: unknown }).name;
  if (typeof name !== "string" || !name.trim() || name.length > 500) throw new Error("Invalid cached environment name.");
  return { type: "environment", configPath: candidate.configPath, revision: candidate.revision!, environment: { name } };
}

function summaries(items: LocalEnvironmentCatalogItem[]): EnvironmentCatalogItem[] {
  return items.map(summary);
}

export class EnvironmentCatalog {
  items: EnvironmentCatalogItem[] = [];
  loading = false;
  restored = false;
  connected = false;
  error?: string;
  cacheWarning?: string;
  private listeners = new Set<() => void>();
  private active = false;
  private generation = 0;
  private restoring?: Promise<void>;
  private off?: () => void;
  private cacheWrites: Promise<void> = Promise.resolve();
  readonly cacheKey: string;

  constructor(private bridge: Bridge, readonly hostId: string, readonly projectId: string, private cache: OfflineCache, private localHostId?: string) {
    if (!hostId || !projectId) throw new Error("Environment catalog requires a host and project.");
    this.cacheKey = `agent-desktop:environment-catalog:v1:${encodeURIComponent(hostId)}:${encodeURIComponent(projectId)}`;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private changed() { for (const listener of this.listeners) listener(); }

  start() {
    this.active = true;
    this.off ??= this.bridge.subscribe(event => {
      if ((event.hostId ?? this.localHostId) !== this.hostId) return;
      if (event.type === "workspace" && "projectId" in event.target && event.target.projectId === this.projectId) void this.refresh();
    });
  }

  stop() {
    this.active = false;
    this.off?.();
    this.off = undefined;
    this.generation++;
    this.loading = false;
    this.changed();
  }

  setConnected(value: boolean) {
    this.connected = value;
    if (!value) {
      this.generation++;
      this.loading = false;
    }
    this.changed();
    if (value && this.active) void this.refresh();
  }

  restore(): Promise<void> {
    return this.restoring ??= (async () => {
      try {
        const raw = await this.cache.read(this.cacheKey);
        if (raw) {
          const saved = JSON.parse(raw) as Partial<Cached>;
          if (saved.version !== 1 || saved.hostId !== this.hostId || saved.projectId !== this.projectId || !Array.isArray(saved.items)) throw new Error("Environment catalog cache belongs to another owner.");
          this.items = saved.items.map(summary);
        }
        this.cacheWarning = undefined;
      } catch (cause) {
        this.cacheWarning = cause instanceof Error ? cause.message : String(cause);
      } finally {
        this.restored = true;
        this.changed();
      }
    })();
  }

  private persist(items: EnvironmentCatalogItem[], generation: number) {
    this.cacheWrites = this.cacheWrites.catch(() => {}).then(async () => {
      if (generation !== this.generation) return;
      await this.cache.write(this.cacheKey, JSON.stringify({ version: 1, hostId: this.hostId, projectId: this.projectId, items } satisfies Cached));
    });
    return this.cacheWrites;
  }

  async refresh() {
    const generation = this.generation;
    await this.restore();
    if (generation !== this.generation || !this.active || !this.connected || !this.restored) return;
    const requestGeneration = ++this.generation;
    this.loading = true;
    this.error = undefined;
    this.changed();
    try {
      const result: WorkspaceQueryResult = await this.bridge.workspaceQuery({ projectId: this.projectId }, { type: "environments.list" }, this.hostId);
      if (requestGeneration !== this.generation || !this.connected) return;
      if (result.type !== "environments.list") throw new Error("The host did not return an environment catalog.");
      const next = summaries(result.environments);
      this.items = next;
      await this.persist(next, requestGeneration);
    } catch (cause) {
      if (requestGeneration === this.generation) this.error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      if (requestGeneration === this.generation) {
        this.loading = false;
        this.changed();
      }
    }
  }
}
