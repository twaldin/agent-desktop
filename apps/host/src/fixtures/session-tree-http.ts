// Actual authenticated host + production worker; all runtime state is disposable.
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { CommandEnvelope, CommandResult } from "@agent-desktop/shared";
import { parseSessionTreeResponse, SESSION_TREE_OWNER_HEADER } from "../../../../packages/shared/src/session-tree";
const root = process.argv[2]!; assert.equal(process.env.HOME, root); await mkdir(root, { recursive: true });
const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "../omp-workers/fixtures/session-tree-worker.ts"), root, "seed"], { env: { HOME: root, PATH: process.env.PATH, TMPDIR: root, TERM: "dumb" }, stdout: "pipe", stderr: "pipe" });
const [seedStatus, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
await writeFile(path.join(root, "seed-run.json"), JSON.stringify({ seedStatus, stdout, stderr })); assert.equal(seedStatus, 0);
const seed = JSON.parse(await readFile(path.join(root, "seed.json"), "utf8")) as { sessionId: string; sessionFile: string; user: string; oldTail: string; cwd: string; agentDir: string };
const nativeFetch = Bun.fetch.bind(Bun); let origin = "";
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
 const target = new URL(input instanceof Request ? input.url : String(input)); if (target.origin !== origin) throw new Error("Only the owned host loopback origin is permitted"); return nativeFetch(input, init);
}, { preconnect() {} }) as typeof fetch;
const { startHost } = await import("../server");
const options = { dataDirectory: path.join(root, "data"), agentDirectory: seed.agentDir, discoveryDirectory: seed.cwd, workerPath: path.join(import.meta.dir, "../omp-workers/fixtures/no-provider-worker.ts"), port: 0, tailscale: false };
let host = await startHost(options); origin = host.connection.origin;
host.store.upsertSession({ id: seed.sessionId, hostId: host.connection.hostId, projectId: null, cwd: seed.cwd, title: "Native history fixture", status: "idle", sessionFile: seed.sessionFile, model: { provider: "tree-controlled", id: "base" }, createdAt: 1, updatedAt: 1, archived: false, approvalOverride: "yolo" });
function headers() { return { authorization: `Bearer ${host.connection.token}`, "content-type": "application/json", [SESSION_TREE_OWNER_HEADER]: host.connection.hostId }; }
async function tree(commandId?: string) { const response = await fetch(`${origin}/v1/sessions/${seed.sessionId}/tree${commandId ? `?commandId=${commandId}` : ""}`, { headers: headers() }); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store"); return parseSessionTreeResponse(await response.json(), host.connection.hostId, seed.sessionId, commandId); }
async function send(envelope: CommandEnvelope, endpoint = "/v23/commands"): Promise<CommandResult> { const response = await fetch(origin + endpoint, { method: "POST", headers: headers(), body: JSON.stringify(envelope) }); const value = await response.json(); assert.equal(response.status, 200, JSON.stringify(value)); return value as CommandResult; }
const receipts: unknown[] = [];
try {
 assert.equal((await fetch(`${origin}/v1/sessions/${seed.sessionId}/tree`)).status, 401);
 assert.equal((await tree()).tree, null, "read cannot silently create an owner");
 assert.equal((await fetch(`${origin}/v1/sessions/${seed.sessionId}/controls`, { headers: headers() })).status, 200);
 const before = (await tree()).tree!;
 const command: CommandEnvelope = { id: "http-navigation", commandVersion: 23, command: { type: "session.tree.mutate", sessionId: seed.sessionId, ticket: before.ticket, mutation: { action: "navigate", targetId: seed.user, summarize: false } } };
 const [first, duplicate] = await Promise.all([send(command), send(command)]); assert.equal(first.ok, true); assert.deepEqual(duplicate, first); receipts.push(first);
 const inspected = await tree(command.id); assert.equal(inspected.receipt?.state, "succeeded"); assert.equal(inspected.receipt?.result?.draft?.images.length, 5);
 const stale = await send({ ...command, id: "stale-second-client" }); assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, "TREE_REJECTED");
 const prompt: CommandEnvelope = { id: "http-edited", commandVersion: 23, command: { type: "session.prompt", sessionId: seed.sessionId, treeTicket: inspected.tree!.ticket, text: "HTTP five-image edit" } };
 const accepted = await send(prompt); assert.equal(accepted.ok, true); assert.ok(accepted.admission?.kind === "user-message"); assert.equal(accepted.admission.images?.length, 5); receipts.push(accepted);
 assert.deepEqual(await send(prompt), accepted, "durable receipt replay never appends another native user");
 for (let n = 0; (await tree()).tree?.busyReason; n++) { if (n > 500) throw new Error("Native controlled turn did not settle"); await Bun.sleep(10); }
 const state = (await tree()).tree!;
 const back: CommandEnvelope = { id: "http-back-original", commandVersion: 23, command: { type: "session.tree.mutate", sessionId: seed.sessionId, ticket: state.ticket, mutation: { action: "navigate", targetId: seed.oldTail, summarize: false } } };
 assert.equal((await send(back)).ok, true);
 await host.stop(); host = await startHost(options); origin = host.connection.origin;
 const recovered = await tree(command.id); assert.equal(recovered.tree, null); assert.equal(recovered.receipt?.state, "succeeded"); assert.equal(recovered.receipt?.result?.draft?.images.length, 5);
 assert.equal((await tree(prompt.id)).receipt?.submission?.entryId, accepted.admission?.entryId);
 assert.equal((await fetch(`${origin}/v1/sessions/${seed.sessionId}/controls`, { headers: headers() })).status, 200);
 assert.ok((await tree()).tree!.entries.find(entry => entry.id === seed.oldTail)?.active);
 assert.equal((await tree()).tree!.entries.find(entry => entry.id === accepted.admission?.entryId)?.active, false);
 await writeFile(path.join(root, "receipts.json"), JSON.stringify(receipts, null, 2));
 console.log(JSON.stringify({ authenticatedProductionHttp: true, sameOriginalSession: true, duplicateCommandsResolveOnce: true, staleSecondClientRejected: true, fiveNativeImages: true, receiptsAndBranchSurviveHostRestart: true, provider: "controlled-local-code-no-inference" }));
} finally { await host.stop(); }
