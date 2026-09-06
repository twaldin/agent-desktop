import { expect, test } from "bun:test";
import { EnvironmentCatalog } from "./environment-catalog";
import { serializeLocalEnvironment, type DesktopBridge, type WorkspaceQueryResult } from "@agent-desktop/shared";
import { createHash } from "node:crypto";

const raw = serializeLocalEnvironment({ version: 1, name: "Cached", setup: { script: "true" } });
const cache = (initial?: string) => { let value = initial ?? null; return { read: async () => value, write: async (_key: string, next: string) => { value = next; } }; };
test("catalog is owner-scoped, caches revisions, and ignores late refresh after disconnect", async () => {
  let resolveQuery!: (value: WorkspaceQueryResult) => void; let calls = 0;
  const bridge: Pick<DesktopBridge, "workspaceQuery" | "subscribe"> = { workspaceQuery: () => { calls++; return new Promise<WorkspaceQueryResult>(resolve => { resolveQuery = resolve; }); }, subscribe: () => () => {} };
  const catalog = new EnvironmentCatalog(bridge, "host-a", "project-a", cache()); catalog.start(); catalog.setConnected(true); await new Promise(resolve => setTimeout(resolve, 0)); catalog.setConnected(false); resolveQuery({ type: "environments.list", environments: [] }); await new Promise(resolve => setTimeout(resolve, 0));
  expect(calls).toBe(1); expect(catalog.items).toEqual([]); expect(catalog.loading).toBe(false);
});
test("restores only exact owner cache and preserves cached choices while offline", async () => {
  const revision = createHash("sha256").update(raw).digest("hex"); const saved = JSON.stringify({ version: 1, hostId: "host-a", projectId: "project-a", items: [{ type: "environment", configPath: "/tmp/a.toml", revision, environment: { version: 1, name: "Cached", setup: { script: "true" } } }] });
  const catalog = new EnvironmentCatalog({ workspaceQuery: async () => { throw Error("offline"); }, subscribe: () => () => {} }, "host-a", "project-a", cache(saved)); await catalog.restore(); catalog.setConnected(false); expect(catalog.restored).toBe(true); expect(catalog.items[0]?.type).toBe("environment");
  const foreign = new EnvironmentCatalog({ workspaceQuery: async () => ({ type: "environments.list", environments: [] }), subscribe: () => () => {} }, "host-b", "project-a", cache(saved)); await foreign.restore(); expect(foreign.items).toEqual([]); expect(foreign.cacheWarning).toContain("another owner");
});
test("stop during deferred cache restore prevents the query", async () => {
  let release!: (value: string | null) => void;
  let queries = 0;
  const delayed = { read: () => new Promise<string | null>(resolve => { release = resolve; }), write: async () => {} };
  const catalog = new EnvironmentCatalog({ workspaceQuery: async () => { queries++; return { type: "environments.list", environments: [] }; }, subscribe: () => () => {} }, "h", "p", delayed);
  catalog.start(); catalog.setConnected(true); catalog.stop(); release(null); await new Promise(resolve => setTimeout(resolve, 0));
  expect(queries).toBe(0);
});

test("a failed query keeps cached choices visible", async () => {
  const revision = createHash("sha256").update(raw).digest("hex");
  const saved = JSON.stringify({ version: 1, hostId: "h", projectId: "p", items: [{ type: "environment", configPath: "/tmp/a.toml", revision, environment: { name: "Cached" } }] });
  const catalog = new EnvironmentCatalog({ workspaceQuery: async () => { throw Error("offline"); }, subscribe: () => () => {} }, "h", "p", cache(saved));
  catalog.start(); catalog.setConnected(true); await new Promise(resolve => setTimeout(resolve, 0));
  expect(catalog.items[0]).toMatchObject({ type: "environment", environment: { name: "Cached" } }); expect(catalog.error).toBe("offline");
});

test("overlapping refreshes retain the newest response", async () => {
  const resolvers: Array<(value: WorkspaceQueryResult) => void> = [];
  const catalog = new EnvironmentCatalog({ workspaceQuery: async () => new Promise<WorkspaceQueryResult>(resolve => { resolvers.push(resolve); }), subscribe: () => () => {} }, "h", "p", cache());
  catalog.start(); catalog.setConnected(true); await new Promise(resolve => setTimeout(resolve, 0)); void catalog.refresh(); await new Promise(resolve => setTimeout(resolve, 0));
  const make = (name: string): WorkspaceQueryResult => ({ type: "environments.list", environments: [{ type: "environment", configPath: `/tmp/${name}.toml`, revision: createHash("sha256").update(raw + name).digest("hex"), environment: { version: 1, name, setup: { script: "true" } } }] });
  resolvers[1]?.(make("newest")); resolvers[0]?.(make("oldest")); await new Promise(resolve => setTimeout(resolve, 0));
  expect(catalog.items[0]).toMatchObject({ type: "environment", environment: { name: "newest" } });
});

test("writes metadata only and serializes a delayed older write before the newest catalog", async () => {
  let saved: string | null = null;
  const firstWrite = Promise.withResolvers<void>(), releaseWrite = Promise.withResolvers<void>();
  let writes = 0, queries = 0;
  const storage = {
    read: async () => saved,
    write: async (_key: string, value: string) => {
      if (++writes === 1) { firstWrite.resolve(); await releaseWrite.promise; }
      saved = value;
    },
  };
  const bridge: Pick<DesktopBridge, "workspaceQuery" | "subscribe"> = {
    subscribe: () => () => {},
    workspaceQuery: async () => ({ type: "environments.list", environments: [{
      type: "environment", configPath: "/tmp/environment.toml", revision: (++queries === 1 ? "a" : "b").repeat(64),
      environment: { version: 1, name: `Choice ${queries}`, setup: { script: "PRIVATE_SETUP" }, actions: [{ name: "Private", icon: null, command: "PRIVATE_ACTION" }] },
    }] }),
  };
  const catalog = new EnvironmentCatalog(bridge, "h", "p", storage);
  catalog.start(); catalog.setConnected(true); await firstWrite.promise;
  const newest = catalog.refresh();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(queries).toBe(2); expect(writes).toBe(1);
  releaseWrite.resolve(); await newest;
  expect(writes).toBe(2);
  const serialized = String(saved);
  expect(serialized).not.toContain("PRIVATE_");
  expect(JSON.parse(serialized).items).toEqual([{ type: "environment", configPath: "/tmp/environment.toml", revision: "b".repeat(64), environment: { name: "Choice 2" } }]);
  catalog.stop();
  const restored = new EnvironmentCatalog(bridge, "h", "p", storage);
  await restored.restore();
  expect(restored.items).toEqual(catalog.items); expect(restored.cacheWarning).toBeUndefined();
});

test("only matching host/project invalidations refresh, and stopped callbacks stay inert", async () => {
  let listener: Parameters<DesktopBridge["subscribe"]>[0] | undefined;
  let queries = 0, unsubscribed = false;
  const bridge: Pick<DesktopBridge, "workspaceQuery" | "subscribe"> = {
    subscribe: callback => { listener = callback; return () => { unsubscribed = true; }; },
    workspaceQuery: async (target, query, hostId) => {
      expect(target).toEqual({ projectId: "p" }); expect(query.type).toBe("environments.list"); expect(hostId).toBe("h");
      queries++; return { type: "environments.list", environments: [] };
    },
  };
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  const catalog = new EnvironmentCatalog(bridge, "h", "p", cache(), "local");
  catalog.start(); catalog.setConnected(true); await tick(); expect(queries).toBe(1);
  listener!({ sequence: 1, type: "workspace", hostId: "other", target: { projectId: "p" } });
  listener!({ sequence: 1, type: "workspace", hostId: "h", target: { projectId: "other" } });
  listener!({ sequence: 1, type: "workspace", target: { projectId: "p" } });
  await tick(); expect(queries).toBe(1);
  listener!({ sequence: 1, type: "workspace", hostId: "h", target: { projectId: "p" } });
  await tick(); expect(queries).toBe(2);
  catalog.stop(); expect(unsubscribed).toBe(true);
  listener!({ sequence: 1, type: "workspace", hostId: "h", target: { projectId: "p" } });
  await catalog.refresh(); await tick(); expect(queries).toBe(2);
});
