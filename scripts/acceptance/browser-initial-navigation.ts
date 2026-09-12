/** Source experiment only. Evaluates the selected native acquisition adapter with
 * a controlled acquisition dependency. It never loads OMP or starts a browser. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sourcePath = process.argv[2];
if (!sourcePath) throw new Error("Pass the exact native src/tools/browser.ts source to inspect.");
const source = await readFile(sourcePath, "utf8");
const start = source.indexOf("export async function createBrowserTabForSession(");
const end = source.indexOf("\nasync function closeBrowser(", start);
assert(start >= 0 && end > start, "Native source boundaries must be present");
const body = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(start, end).replaceAll("export async function", "async function"));
class BrowserTabCreateRejected extends Error { override name = "BrowserTabCreateRejected"; }
const acquisitions: unknown[][] = [];
const releases: unknown[][] = [];
let disposition: "headless" | "cmux" | "relay" = "headless";
let beforeReturn: (() => void) | undefined;
let currentTab: unknown;
const acquire = async (...args: unknown[]) => {
  acquisitions.push(args);
  beforeReturn?.();
  currentTab = { name: "desktop-request-1", targetId: "target", kindTag: disposition,
    backend: disposition === "cmux" ? "cmux" : "worker", info: { url: "https://example.invalid/redirected", title: "Result", viewport: { width: 640, height: 480 } } };
  return { result: { created: true, tab: currentTab } };
};
const create = new Function("BrowserTabCreateRejected", "ToolError", "clampTimeout", "acquireBrowserTab", "releaseTab", "getTab",
  `${body}\nreturn createBrowserTabForSession;`)(BrowserTabCreateRejected, Error, () => 30, acquire, async (...args: unknown[]) => { releases.push(args); }, () => currentTab) as
  (nativeSession: typeof session, request: { name: string; initialUrl?: unknown }) => Promise<{ targetDisposition: string; url: string }>;
let owner = "session";
const settings = { get: (key: string) => key === "browser.enabled" ? true : 30 };
const session = { isDisposed: false, settings, sessionManager: { getSessionId: () => owner, getCwd: () => "/fixture" } };
let checks = 0;
for (const [kind, expected] of [["headless", "created-page"], ["cmux", "created-surface"], ["relay", "adopted-existing-target"]] as const) {
  disposition = kind;
  const result = await create(session, { name: "desktop-request-1", initialUrl: "https://example.invalid/requested?q=a%20b" });
  const args = acquisitions.at(-1)!;
  assert.deepEqual(args[2], { action: "open", name: "desktop-request-1", url: "https://example.invalid/requested?q=a%20b" });
  assert.equal((args[0] as { settings: unknown }).settings, settings);
  assert.equal(args[3], 30_000); assert.equal(args[4], undefined); assert.equal(args[5], true);
  assert.equal(result.targetDisposition, expected); assert.equal(result.url, "https://example.invalid/redirected");
  checks++;
}
for (const initialUrl of [null, "file:///tmp/x", "data:text/html,x", "https://example.invalid/ x"]) {
  const count = acquisitions.length;
  await assert.rejects(create(session, { name: "desktop-request-1", initialUrl }), { name: "BrowserTabCreateRejected" });
  assert.equal(acquisitions.length, count); checks++;
}
await create(session, { name: "desktop-request-1" });
assert.deepEqual(acquisitions.at(-1)![2], { action: "open", name: "desktop-request-1" }); checks++;
beforeReturn = () => { owner = "replacement"; };
await assert.rejects(create(session, { name: "desktop-request-1", initialUrl: "about:blank" }), /session changed/);
assert.equal(releases.length, 1); checks++;
console.log(JSON.stringify({ checks, acquisitionCalls: acquisitions.length, nativeRuntime: false,
  sourcePath, sourceSha256: new Bun.CryptoHasher("sha256").update(source).digest("hex"),
  limit: "Selected native adapter plus controlled acquisition, not SDK/worker/DOM/network/browser proof" }));
