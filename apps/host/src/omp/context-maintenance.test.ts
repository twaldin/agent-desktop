import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

type Result = Record<string, any>;
const fixture = path.resolve(import.meta.dir, "../omp-workers/fixtures/context-maintenance-native.ts");
async function run(scenario: string): Promise<Result> {
  const root = await mkdtemp(path.join(tmpdir(), `agent-desktop-context-maintenance-${scenario}-`));
  const dirs = ["tmp", "cache", "config", "data"].map(name => path.join(root, name));
  await Promise.all(dirs.map(directory => mkdir(directory, { recursive: true })));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let stdout: Promise<string> | undefined, stderr: Promise<string> | undefined;
  let primary: unknown, result: Result | undefined;
  try {
    child = Bun.spawn([process.execPath, fixture, root, scenario], { cwd: path.resolve(import.meta.dir, "../../../.."),
      env: { HOME: root, TMPDIR: dirs[0]!, XDG_CACHE_HOME: dirs[1]!, XDG_CONFIG_HOME: dirs[2]!, XDG_DATA_HOME: dirs[3]!,
        PI_CODING_AGENT_DIR: path.join(root, "agent"), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin` },
      stdout: "pipe", stderr: "pipe" });
    stdout = new Response(child.stdout as ReadableStream<Uint8Array>).text();
    stderr = new Response(child.stderr as ReadableStream<Uint8Array>).text();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; child?.kill(); }, 25_000);
    const [out, err, exitCode] = await Promise.all([stdout, stderr, child.exited]).finally(() => clearTimeout(timeout));
    if (timedOut) throw new Error(`${scenario}: owned fixture exceeded 25 seconds and was terminated.\n${err}`);
    expect(exitCode, `${scenario}: stdout:\n${out}\nstderr:\n${err}`).toBe(0);
    try { result = JSON.parse(await readFile(path.join(root, "result.json"), "utf8")); }
    catch (error) { throw new Error(`${scenario}: owned result read failed. stdout:\n${out}\nstderr:\n${err}`, { cause: error }); }
  } catch (error) { primary = error; }
  const cleanup: unknown[] = [];
  if (child) {
    if (child.exitCode === null) child.kill();
    const settled = await Promise.allSettled([child.exited, ...(stdout ? [stdout] : []), ...(stderr ? [stderr] : [])]);
    cleanup.push(...settled.flatMap(value => value.status === "rejected" ? [value.reason] : []));
  }
  try { await rm(root, { recursive: true, force: true }); } catch (error) { cleanup.push(error); }
  if (primary !== undefined && cleanup.length) throw new AggregateError([primary, ...cleanup], `${scenario}: fixture and cleanup failed.`);
  if (primary !== undefined) throw primary;
  if (cleanup.length) throw new AggregateError(cleanup, `${scenario}: fixture cleanup failed.`);
  return result!;
}
const output = (result: Result) => result.result.accepted.output as string;
const expectRuntimeIdentity = (result: Result) => expect(result.runtimeIdentity).toMatchObject({
  id: result.originalIdentity.id, cwd: result.originalIdentity.cwd, sameFile: true,
});

test.each([
  ["compact-default", "soft", undefined],
  ["compact-soft", "soft", "exact owned focus"],
  ["compact-legacy-focus", "soft", "exact legacy focus"],
  ["compact-remote", "remote", "exact owned focus"],
] as const)("%s executes the actual native method and survives cold reopen", async (scenario, method, focus) => {
  const result = await run(scenario);
  expect(result.result).toMatchObject({ accepted: { kind: "native-command", command: "compact" }, completion: false });
  expect(output(result)).toMatch(/^Compaction complete\. Tokens: \d+ -> \d+ \(saved -?\d+\)\.$/);
  expect(result.blockedFetches).toBe(0);
  expect(result.live.compactions).toHaveLength(1);
  expect(result.live.compactions[0].method).toBe(method);
  expect(result.reopened.compactions).toEqual(result.live.compactions);
  expect(result.reopened.commands).toEqual(result.live.commands);
  expect(result.reopened.contextMessages).toBeGreaterThan(0);
  expect(result.reopened.contextHasControlledSummary).toBe(true);
  expect(result.followup).toBe(true);
  expect(result.followupAccepted).toMatchObject({ kind: "user-message" });
  expectRuntimeIdentity(result);
  expect(result.followupRequests).toHaveLength(1);
  expectRuntimeIdentity(result);
  expect(result.followupRequests[0].body).toContain("Controlled follow-up after cold reopen.");
  expect(result.followupRequests[0].body).toContain(method === "remote" ? "Controlled remote compact summary" : "Controlled soft compact summary");
  if (focus) expect(result.requests.some((request: any) => request.focus === focus)).toBe(true);
}, 30_000);

test("remote compact falls back through the actual soft provider path", async () => {
  const result = await run("compact-remote-fallback");
  expect(result.requests[0]).toMatchObject({ stream: false, focus: "fallback focus" });
  expect(result.requests.some((request: any) => request.stream)).toBe(true);
  expect(result.live.compactions[0].method).toBe("soft");
  expect(result.reopened.compactions).toEqual(result.live.compactions);
  expect(result.followupRequests).toHaveLength(1);
  expect(result.followupRequests[0].body).toContain("Controlled soft compact summary");
}, 30_000);

test("snapcompact is local, durable, and rejects focus before changing history", async () => {
  const compact = await run("compact-snapcompact");
  expect(compact.requests).toEqual([]); expect(compact.blockedFetches).toBe(0);
  expect(compact.live.compactions[0]).toMatchObject({ method: "snapcompact" });
  expect(compact.reopened.compactions).toEqual(compact.live.compactions);
  expect(compact.reopened.contextMessages).toBeGreaterThan(0);
  expect(compact.followupRequests).toHaveLength(1);
  expectRuntimeIdentity(compact);
  expect(compact.followupRequests[0].body).toContain("Controlled follow-up after cold reopen.");
  expect(compact.followupRequests[0].body).toContain("HISTORY");
  expect(compact.followupRequests[0].body).toContain("Owned compact user 0");
  const invalid = await run("compact-invalid-focus");
  expect(output(invalid)).toBe("/compact snapcompact does not take focus instructions (it archives history without an LLM summary).");
  expect(invalid.requests).toEqual([]); expect(invalid.live.compactions).toEqual([]); expect(invalid.reopened.compactions).toEqual([]);
  expect(invalid.followupRequests).toHaveLength(1);
  expect(invalid.followupRequests[0].body).toContain("Owned compact user 0");
}, 30_000);

test("native compact provider failure is a durable command result without a compaction", async () => {
  const result = await run("compact-error");
  expect(output(result)).toContain("Compaction failed:");
  expect(output(result)).toContain("controlled compact provider failure");
  expect(result.live.compactions).toEqual([]); expect(result.reopened.compactions).toEqual([]);
  expect(result.reopened.commands).toEqual(result.live.commands);
}, 30_000);

test("a post-command flush failure preserves the compact admission as outcome unknown", async () => {
  const result = await run("compact-flush-error");
  expect(result.result).toEqual({
    accepted: { status: "rejected", reason: { name: "OmpPromptAdmissionError", code: "OUTCOME_UNKNOWN",
      message: expect.stringContaining("controlled post-command flush failure") } },
    completion: { status: "rejected", reason: { name: "Error", message: "controlled post-command flush failure" } },
  });
  expect(result.requests.length).toBeGreaterThan(0);
  expect(result.blockedFetches).toBe(0);
  // The actual native compaction ran before persistence verification failed.
  // Its disk state is intentionally not used to turn this uncertain admission
  // into either a success receipt or a replayable refusal.
  expect(result.live.compactions).toHaveLength(1);
}, 30_000);

test.each([
  ["shake-default", "Shook 1 block", { images: 1, thinking: 1, shaken: 1, artifactLinks: 1 }],
  ["shake-elide", "Shook 1 block", { images: 1, thinking: 1, shaken: 1, artifactLinks: 1 }],
  ["shake-images", "Dropped 1 image", { images: 0, thinking: 1, shaken: 0, artifactLinks: 0 }],
  ["shake-thinking", "Dropped 1 thinking block", { images: 1, thinking: 0, shaken: 0, artifactLinks: 0 }],
] as const)("%s rewrites the actual native branch and survives reopen", async (scenario, message, counts) => {
  const result = await run(scenario);
  expect(output(result)).toContain(message);
  expect(result.requests).toEqual([]); expect(result.blockedFetches).toBe(0);
  expect(result.live).toMatchObject(counts); expect(result.reopened).toMatchObject(counts);
  expect(result.reopened.commands).toEqual(result.live.commands);
  expect(result.followup).toBe(true); expect(result.followupRequests).toHaveLength(1);
  expectRuntimeIdentity(result);
  const body = result.followupRequests[0].body as string;
  if (scenario === "shake-images") { expect(body).not.toContain("iVBORw0KGgo="); expect(body).toContain("Owned private reasoning"); }
  else if (scenario === "shake-thinking") { expect(body).toContain("[image omitted: undecodable image/png data"); expect(body).not.toContain("Owned private reasoning"); }
  else {
    expect(body).toContain("[shaken ~"); expect(body).not.toContain("heavy block heavy block");
    expect(result.artifact).toMatchObject({ pathWithinOwnedRoot: true, content: expect.stringContaining("heavy block heavy block") });
  }
}, 30_000);

test("invalid shake input persists native usage text without rewriting history", async () => {
  const result = await run("shake-invalid");
  expect(output(result)).toBe('Unknown /shake mode "invalid". Use elide, images, or thinking.');
  expect(result.live).toMatchObject({ images: 1, thinking: 1, shaken: 0, artifactLinks: 0 });
  expect(result.reopened).toMatchObject({ images: 1, thinking: 1, shaken: 0, artifactLinks: 0 });
  expect(result.followupRequests).toHaveLength(1);
  expectRuntimeIdentity(result);
  expect(result.followupRequests[0].body).toContain("[image omitted: undecodable image/png data");
  expect(result.followupRequests[0].body).toContain("Owned private reasoning");
  expect(result.followupRequests[0].body).toContain("heavy block heavy block");
}, 30_000);

test("shake reports and persists the actual no-op result when no eligible context exists", async () => {
  const result = await run("shake-noop");
  expect(output(result)).toBe("Nothing to shake.");
  expect(result.requests).toEqual([]);
  expect(result.live).toMatchObject({ images: 0, thinking: 0, shaken: 0, artifactLinks: 0 });
  expect(result.reopened).toMatchObject({ images: 0, thinking: 0, shaken: 0, artifactLinks: 0 });
  expect(result.reopened.commands).toEqual(result.live.commands);
  expect(result.followupRequests).toHaveLength(1);
  expectRuntimeIdentity(result);
  expect(result.followupRequests[0].body).toContain("Controlled follow-up after cold reopen.");
}, 30_000);

test("real extension and custom-command winners keep compact and shake precedence", async () => {
  const result = await run("precedence");
  expect(result).toMatchObject({ extensionLoaded: true, customLoaded: true, extensionCalls: 1, customEffect: "custom\n",
    requests: 0, blockedFetches: 0, compactions: 0,
    compact: { accepted: { kind: "native-command", command: "compact" }, completion: false },
    shake: { accepted: { kind: "native-command", command: "shake" }, completion: false },
    inverse: { customLoaded: true, extensionLoaded: true, extensionCalls: 1, customEffect: "inverse\n", compactions: 0,
      compact: { accepted: { kind: "native-command", command: "compact" }, completion: false },
      shake: { accepted: { kind: "native-command", command: "shake" }, completion: false } } });
}, 30_000);

test("removing a custom compact shadow makes the actual builtin the dispatch winner", async () => {
  const result = await run("precedence-removal");
  expect(result).toMatchObject({ shadowLoaded: true, shadowRemoved: true, requests: 0, compactions: ["snapcompact"],
    compact: { accepted: { kind: "native-command", command: "compact" }, completion: false } });
}, 30_000);

test("the actual native pre-compaction extension hook can veto the builtin result", async () => {
  const result = await run("compact-hook-veto");
  expect(result).toMatchObject({ hookCalls: 1, requests: 0, compactions: 0,
    compact: { accepted: { kind: "native-command", command: "compact" }, completion: false } });
  expect(result.compact.accepted.output).toBe("Compaction failed: Compaction cancelled");
}, 30_000);
