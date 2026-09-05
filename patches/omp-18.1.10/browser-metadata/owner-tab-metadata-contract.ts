// Executes only against the copied candidate package. It opens a disposable
// native OMP tab and reads the candidate's immutable owner-filtered metadata.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.argv[2]!;
const nativePackage = process.env.BROWSER_METADATA_NATIVE_PACKAGE;
assert(nativePackage, "Candidate package path is required");
await Promise.all(["agent", "project", "sessions"].map(name => mkdir(path.join(root, name), { recursive: true, mode: 0o700 })));
const agentDir = path.join(root, "agent");
const cwd = path.join(root, "project");
await writeFile(path.join(agentDir, "config.yml"), "browser:\n  enabled: true\n  headless: true\n  cmux: false\n  relay: false\nretry:\n  enabled: false\n");
const mod = await import(pathToFileURL(path.join(nativePackage, "src/index.ts")).href);
const supervisor = await import(pathToFileURL(path.join(nativePackage, "src/tools/browser/tab-supervisor.ts")).href);
const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = mod as typeof import("@oh-my-pi/pi-coding-agent");
const { listTabsForOwner, releaseAllTabs } = supervisor as typeof import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor") & { listTabsForOwner(ownerSessionId: string): readonly Array<{ name: string; ownerSessionId: string; targetId: string; backend: string; kindTag: string; state: string; info: { url: string; title?: string; targetId: string; viewport: { width: number; height: number } } }> };
const checks: string[] = [];
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
let failure: unknown;
try {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "External fetch/provider/download forbidden");
    return nativeFetch(input, init);
  }, { preconnect: () => {} }) as typeof fetch;
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => new URL(request.url).pathname === "/tab"
    ? new Response("<!doctype html><title>Candidate native tab</title><main>owner metadata</main>", { headers: { "Content-Type": "text/html" } })
    : new Response("not found", { status: 404 }) });
  const url = `http://127.0.0.1:${server.port}/tab`;
  const auth = await discoverAuthStorage(agentDir);
  const settings = await Settings.loadReadOnly({ cwd, agentDir });
  const manager = SessionManager.create(cwd, path.join(root, "sessions"));
  await manager.ensureOnDisk();
  const created = await createAgentSession({ cwd, agentDir, settings, authStorage: auth, modelRegistry: new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings }), sessionManager: manager, agentRegistry: new AgentRegistry(), toolNames: ["eval"], disableExtensionDiscovery: true, enableMCP: false, hasUI: false });
  session = created.session;
  const evalTool = session.getToolByName("eval");
  assert(evalTool, "Native Eval tool unavailable");
  const name = "owner-metadata-proof";
  const opened = await evalTool.execute(crypto.randomUUID(), { language: "js", title: "Open candidate tab", code: `await browser.open({name:${JSON.stringify(name)},url:${JSON.stringify(url)},viewport:{width:640,height:480,scale:1},timeout:30});`, timeout: 30 });
  assert(!opened.isError, "Native browser prelude failed to open its target");
  const ownerId = manager.getSessionId();
  const tabs = listTabsForOwner(ownerId);
  assert.equal(tabs.length, 1, "Owner enumeration must see exactly its native-created tab");
  const tab = tabs[0]!;
  assert.deepEqual(Object.keys(tab).sort(), ["backend", "info", "kindTag", "name", "ownerSessionId", "state", "targetId"]);
  assert.equal(tab.name, name); assert.equal(tab.ownerSessionId, ownerId); assert.equal(tab.info.url, url); assert.equal(tab.info.title, "Candidate native tab"); assert.equal(tab.targetId, tab.info.targetId); assert.equal(tab.backend, "worker"); assert.equal(tab.kindTag, "headless"); assert.equal(tab.state, "alive");
  assert(Object.isFrozen(tabs) && Object.isFrozen(tab) && Object.isFrozen(tab.info) && Object.isFrozen(tab.info.viewport), "Metadata must be immutable cloned values");
  assert.equal(listTabsForOwner("other-native-owner").length, 0, "Different owner must never enumerate this tab");
  assert.equal(listTabsForOwner("").length, 0, "Absent owner must never become a wildcard");
  checks.push("actual native browser target exposes owner-filtered exact target, URL, title, viewport, and native state", "owner isolation rejects different and absent owners", "metadata contains no browser handle and returned snapshot is immutable");
} catch (error) { failure = error; }
finally {
  await session?.dispose().catch(error => { failure ??= error; });
  await releaseAllTabs({ kill: true }).catch(error => { failure ??= error; });
  server?.stop(true);
  await writeFile(path.join(root, "result.json"), JSON.stringify({ passed: failure === undefined, checks, scope: "Copied pinned OMP candidate only; disposable native browser/profile and local HTTP fixture; no provider, existing profile, host service, or global dependency modification.", ...(failure === undefined ? {} : { error: String(failure), stack: failure instanceof Error ? failure.stack : undefined }) }, null, 2));
}
if (failure) throw failure;
