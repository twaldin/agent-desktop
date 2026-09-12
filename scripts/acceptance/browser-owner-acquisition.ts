/** Evaluate the selected native adapter with controlled registry/acquisition only.
 * No SDK import, AgentSession construction, browser, worker or provider executes. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("Pass an exact native src/tools/browser.ts source file.");
const source = await readFile(sourcePath, "utf8");
const start = source.indexOf("export async function createBrowserTabForSession(");
const end = source.indexOf("\nasync function closeBrowser(", start);
assert(start >= 0 && end > start, "Native adapter source boundaries are required.");
const selected = source.slice(start, end);
const body = new Bun.Transpiler({ loader: "ts" }).transformSync(selected.replaceAll("export async function", "async function"));
class Rejected extends Error { override name = "BrowserTabCreateRejected"; }
interface Result { name: string; ownerSessionId: string; targetId: string; targetDisposition: string; url: string; viewport: { width: number } }
interface Settings { get(key: string): unknown }
interface Owner { id: string; cwd: string; settings: Settings; signal: AbortSignal }
interface Session { isDisposed: boolean; settings: Settings; sessionManager: { getSessionId(): string; getCwd(): string } }
type Request = { name: string; initialUrl?: unknown };
const request: Request = { name: "desktop-request", initialUrl: "https://example.invalid/request?q=a%20b" };
const settings: Settings = { get: key => key === "browser.enabled" ? true : 37 };

function harness(kind = "headless") {
  const calls: { context: { cwd: string; getSessionId(): string; settings: Settings }; params: unknown; timeout: number; signal?: AbortSignal; createOnly: boolean }[] = [];
  const releases: { name: string; targetId?: string }[] = [];
  let current: { name: string; targetId: string } | undefined;
  let barrier: (() => Promise<void>) | undefined;
  let sawAbort = false;
  const acquire = async (context: typeof calls[number]["context"], name: string, params: unknown, timeout: number, signal: AbortSignal | undefined, createOnly: boolean) => {
    calls.push({ context, params, timeout, signal, createOnly });
    signal?.addEventListener("abort", () => { sawAbort = true; }, { once: true });
    const tab = { name, targetId: "acquired-target", ownerSessionId: context.getSessionId(), backend: kind === "cmux" ? "cmux" : "worker", kindTag: kind,
      info: { url: "https://example.invalid/redirect", title: "Observed", viewport: { width: 640, height: 480 } } };
    current = tab;
    await barrier?.();
    return { result: { created: true, tab } };
  };
  const api = new Function("BrowserTabCreateRejected", "ToolError", "clampTimeout", "acquireBrowserTab", "releaseTab", "getTab",
    `${body}\nreturn { session: createBrowserTabForSession, owner: typeof createBrowserTabForOwner === 'function' ? createBrowserTabForOwner : undefined };`)(
      Rejected, Error, (_tool: string, _requested: unknown, max: number) => max, acquire,
      async (name: string) => { releases.push({ name, targetId: current?.targetId }); current = undefined; }, () => current,
    ) as { session(session: Session, request: Request): Promise<Result>; owner?: (owner: Owner, request: Request) => Promise<Result> };
  return { api, calls, releases, get sawAbort() { return sawAbort; },
    hold() { const gate = Promise.withResolvers<void>(); barrier = () => gate.promise; return gate; },
    replace() { current = { name: request.name, targetId: "replacement-target" }; },
    fail(message: string) { barrier = async () => { throw new Error(message); }; } };
}
const completed: string[] = [];
async function sessionReplacement() {
  const h = harness(), gate = h.hold();
  let id = "session-one";
  const session: Session = { isDisposed: false, settings, sessionManager: { getSessionId: () => id, getCwd: () => "/original" } };
  const pending = h.api.session(session, request);
  id = "session-two"; h.replace(); gate.resolve();
  await assert.rejects(pending, /session changed/);
  assert.deepEqual(h.releases, [], "Retirement must not close a same-name replacement target");
  assert.equal(h.calls.length, 1);
  completed.push("session retirement leaves same-name replacement untouched");
}
if (process.argv.includes("--session-replacement")) {
  await sessionReplacement();
} else {
  for (const [kind, expected] of [["headless", "created-page"], ["spawned", "adopted-existing-target"], ["connected", "adopted-existing-target"], ["relay", "adopted-existing-target"], ["cmux", "created-surface"]]) {
    const h = harness(kind), lifetime = new AbortController();
    assert.equal(typeof h.api.owner, "function", "Explicit native owner API is required");
    const owner: Owner = { id: "draft-resource", cwd: "/draft-project", settings, signal: lifetime.signal };
    const result = await h.api.owner!(owner, request);
    assert.equal(result.ownerSessionId, "draft-resource"); assert.equal(result.targetDisposition, expected);
    assert.equal(result.url, "https://example.invalid/redirect"); assert.equal(result.targetId, "acquired-target");
    assert.equal(h.calls.length, 1); assert.equal(h.calls[0]!.context.cwd, "/draft-project");
    assert.equal(h.calls[0]!.context.getSessionId(), "draft-resource"); assert.equal(h.calls[0]!.timeout, 37_000);
    assert.equal(h.calls[0]!.createOnly, true);
    assert.deepEqual(h.calls[0]!.params, { action: "open", name: request.name, url: request.initialUrl });
    assert.equal(Object.isFrozen(result), true); assert.equal(Object.isFrozen(result.viewport), true);
    completed.push(`${kind} metadata projection without AgentSession`);
  }
  {
    const h = harness(), lifetime = new AbortController();
    lifetime.abort();
    await assert.rejects(h.api.owner!({ id: "retired", cwd: "/draft", settings, signal: lifetime.signal }, request), /retired/);
    assert.equal(h.calls.length, 0); completed.push("retired owner rejected before acquisition");
  }
  {
    const h = harness(), lifetime = new AbortController();
    for (const id of ["", "bad\0id", "x".repeat(201)]) {
      await assert.rejects(h.api.owner!({ id, cwd: "/draft", settings, signal: lifetime.signal }, request), { name: "BrowserTabCreateRejected" });
    }
    await assert.rejects(h.api.owner!({ id: "valid", cwd: "/draft", signal: lifetime.signal, settings: { get: () => false } }, request), /disabled/);
    assert.equal(h.calls.length, 0); completed.push("invalid identity and disabled settings never acquire");
  }
  {
    const h = harness(), lifetime = new AbortController();
    for (const input of [{ name: "" }, { name: "valid", initialUrl: "file:///private/file" }, { name: "valid", initialUrl: "https://example.invalid/ space" }]) {
      await assert.rejects(h.api.owner!({ id: "valid", cwd: "/draft", signal: lifetime.signal, settings }, input), { name: "BrowserTabCreateRejected" });
    }
    assert.equal(h.calls.length, 0); completed.push("shared request preflight never acquires malformed requests");
  }
  for (const replace of [false, true]) {
    const h = harness(), gate = h.hold(), lifetime = new AbortController();
    const pending = h.api.owner!({ id: "draft", cwd: "/draft", settings, signal: lifetime.signal }, request);
    lifetime.abort(); if (replace) h.replace(); gate.resolve();
    await assert.rejects(pending, /owner retired/);
    assert.equal(h.sawAbort, true, "Retirement reaches the acquisition signal");
    assert.deepEqual(h.releases, replace ? [] : [{ name: request.name, targetId: "acquired-target" }]);
    assert.equal(h.calls.length, 1); completed.push(replace ? "owner retirement preserves replacement" : "owner retirement releases acquired tab only");
  }
  {
    const h = harness(), gate = h.hold(), lifetime = new AbortController();
    const owner: Owner = { id: "original-owner", cwd: "/original-cwd", settings, signal: lifetime.signal };
    const pending = h.api.owner!(owner, request); owner.id = "later-owner"; owner.cwd = "/later-cwd"; gate.resolve();
    const result = await pending;
    assert.equal(result.ownerSessionId, "original-owner"); assert.equal(h.calls[0]!.context.cwd, "/original-cwd");
    completed.push("captured owner inputs do not retarget in-flight acquisition");
  }
  {
    const h = harness(), lifetime = new AbortController(); h.fail("Configured backend failed");
    await assert.rejects(h.api.owner!({ id: "draft", cwd: "/draft", settings, signal: lifetime.signal }, request), /Configured backend failed/);
    assert.equal(h.calls.length, 1); assert.deepEqual(h.releases, []); completed.push("backend failure propagates without fallback");
  }
  await sessionReplacement();
}
console.log(JSON.stringify({ sourcePath, sourceSha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"), selectedSha256: new Bun.CryptoHasher("sha256").update(selected).digest("hex"),
  completed, checks: completed.length, nativeRuntime: false, limit: "Selected actual adapter with controlled acquisition/registry; not SDK, configured-backend execution, worker, browser or UI proof" }, null, 2));
