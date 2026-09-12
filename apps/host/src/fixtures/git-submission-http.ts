import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandEnvelope, CommandResult, GitActionContext, GitSubmissionReceipt } from "@agent-desktop/shared";
import { startHost } from "../server";

// The parent supplies a new HOME, agent directory, and a network-refusing native
// worker entry. Only the local HTTP contract and disposable Git repo are used.
const root = process.env.COMPOUND_HTTP_ROOT!;
const cwd = join(root, "repo"), data = join(root, "data"), agent = join(root, "agent");
await Promise.all([cwd, agent].map(path => mkdir(path, { recursive: true })));
function git(...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  assert.equal(result.exitCode, 0, new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
git("init", "-q", "--initial-branch=main"); git("config", "user.name", "HTTP Fixture"); git("config", "user.email", "fixture@example.invalid");
git("config", "commit.gpgSign", "false"); git("config", "core.hooksPath", join(root, "empty-hooks"));
await writeFile(join(cwd, "source.js"), "const value=1;\n"); git("add", "source.js"); git("commit", "-qm", "base");
await writeFile(join(cwd, "source.js"), "const value = 1;\n"); git("add", "source.js");
const options = { dataDirectory: data, agentDirectory: agent, discoveryDirectory: cwd, tailscale: false, port: 0,
  workerPath: new URL("../omp-workers/fixtures/commit-worker-probe.ts", import.meta.url).pathname };
let host = await startHost(options);
let checks = 0;
function headers() { return { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" }; }
async function post(path: string, body: unknown) { return fetch(`${host.connection.origin}${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) }); }
try {
  const project = host.store.addProject({ path: cwd }), target = { projectId: project.id };
  const query = await post("/v1/workspace/query", { target, query: { type: "git.action-context" } });
  const queryText = await query.text();
  assert.equal(query.status, 200, queryText);
  const contextResult = JSON.parse(queryText) as { context: GitActionContext };
  assert.ok(contextResult.context.revision); checks++;
  const envelope: CommandEnvelope = { id: "original-http", commandVersion: 10, command: { type: "workspace.mutate", target,
    action: { type: "git.submit", intent: { operation: "commit", selectionMode: "staged", contextRevision: contextResult.context.revision, message: "" } } } };
  const rejected = await post("/v9/commands", envelope);
  assert.equal(rejected.status, 422); assert.equal(host.store.getCommand(envelope.id), undefined); checks++;
  assert.deepEqual((await host.snapshot()).gitSubmissions, { commandVersion: 10 }); checks++;
  const first = await post("/v10/commands", envelope); assert.equal(first.status, 200);
  const result = await first.json() as CommandResult;
  assert.equal(result.ok, true);
  assert.ok(result.ok && result.value && "type" in result.value && result.value.type === "git.submit");
  const receipt = (result.value as { receipt: GitSubmissionReceipt }).receipt;
  assert.equal(receipt.outcome, "succeeded");
  assert.equal(receipt.generatedMessage, "style: reformatted source.js");
  assert.equal(git("log", "-1", "--format=%s"), receipt.generatedMessage);
  assert.equal(git("rev-list", "--count", "HEAD"), "2"); checks++;
  assert.equal(await Bun.file(process.env.COMMIT_WORKER_FETCH!).exists(), false);
  assert.equal(host.store.listSessions().length, 0); checks++;
  const again = await post("/v10/commands", envelope); assert.deepEqual(await again.json(), result); checks++;
  const reused = await post("/v10/commands", { ...envelope, command: { ...envelope.command, target: { projectId: "other" } } });
  assert.equal((await reused.json() as { error: { code: string } }).error.code, "COMMAND_ID_REUSED"); checks++;
  const read = await post("/v1/workspace/query", { target, query: { type: "git.submission", commandId: envelope.id } });
  assert.deepEqual((await read.json() as { receipt: GitSubmissionReceipt }).receipt, receipt); checks++;
  await host.stop(); host = await startHost(options);
  const restart = await post("/v10/commands", envelope); assert.deepEqual(await restart.json(), result);
  assert.equal(git("rev-list", "--count", "HEAD"), "2"); checks++;
  console.log(JSON.stringify({ checks, nativeGeneratedMessage: receipt.generatedMessage, sessions: 0, fetchSentinel: false, commitsIncludingBase: 2 }));
} finally { await host.stop(); }
