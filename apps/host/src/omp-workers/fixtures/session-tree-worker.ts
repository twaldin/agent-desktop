// Disposable real worker + native journal. Controlled provider is local code, not model inference.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
const root = process.argv[2]!;
assert.equal(process.env.HOME, root);
globalThis.fetch = Object.assign(async () => { throw new Error("Network disabled in native tree worker fixture"); }, { preconnect() {} }) as typeof fetch;
const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
await mkdir(agentDir, { recursive: true }); await mkdir(cwd, { recursive: true });
const extension = path.join(root, "controlled-tree.ts");
const aiEvents = import.meta.resolve("@oh-my-pi/pi-ai/utils/event-stream");
await writeFile(extension, `import { AssistantMessageEventStream } from ${JSON.stringify(aiEvents)};
import { appendFile, access, writeFile } from 'node:fs/promises';
export default function(pi) {
 pi.on('before_agent_start', async () => { try { await access(${JSON.stringify(path.join(root, "hold-prompt"))}); await writeFile(${JSON.stringify(path.join(root, "prompt-entered"))}, '1'); while(true){try{await access(${JSON.stringify(path.join(root, "release-prompt"))});break;}catch{await Bun.sleep(5);}} } catch {} });
 pi.registerProvider('tree-controlled', { baseUrl:'https://controlled.invalid', apiKey:'owned-inert-fixture-key', api:'tree-controlled-api', models:[{id:'base',name:'Controlled transport, no inference',reasoning:false,input:['text','image'],contextWindow:128000,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}],streamSimple(model,context){
 appendFile(${JSON.stringify(path.join(root, "provider-inputs.jsonl"))},JSON.stringify(context)+'\\n');
 const stream=new AssistantMessageEventStream(); const message={role:'assistant',content:[{type:'text',text:'Controlled local continuation'}],api:model.api,provider:model.provider,model:model.id,usage:{input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:'stop',timestamp:Date.now()};stream.push({type:'start',partial:message});stream.push({type:'done',reason:'stop',message});return stream;
 }});
}`);
await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(extension)}\ndefaultModel: tree-controlled/base\nretry:\n  enabled: false\n`);
const { SessionManager } = await import("@oh-my-pi/pi-coding-agent");
const manager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
await manager.ensureOnDisk(); manager.appendModelChange("tree-controlled/base");
const image = { type: "image" as const, mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jY1kAAAAASUVORK5CYII=" };
const user = manager.appendMessage({ role: "user", content: [{ type: "text", text: "Original five-image question" }, ...Array.from({ length: 5 }, () => ({ ...image }))], timestamp: 1 });
manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Original answer" }], api: "tree-controlled-api" as never, provider: "tree-controlled", model: "base", stopReason: "stop", timestamp: 2, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const oldTail = manager.getLeafId(), originalIds = manager.getEntries().map(entry => entry.id), sessionFile = manager.getSessionFile()!;
await manager.flush();
if (process.argv[3] === "seed") { await writeFile(path.join(root, "seed.json"), JSON.stringify({ sessionId: manager.getSessionId(), sessionFile, user, oldTail, originalIds, cwd, agentDir })); process.exit(0); }
const { WorkerRuntime } = await import("../runtime");
const runtime = new WorkerRuntime({ agentDir, workerPath: path.join(import.meta.dir, "no-provider-worker.ts"), environment: { HOME: root, PATH: process.env.PATH, TMPDIR: root, PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" } });
let session = await runtime.open({ sessionFile, interactions: true, approvalOverride: "yolo" });
const sessionId = session.id;
try {
 const before = await session.getTree();
 const result = await session.mutateTree("worker-navigation", { sessionId, ticket: before.ticket, mutation: { action: "navigate", targetId: user, summarize: false } });
 assert.equal(result.draft?.images.length, 5); assert.deepEqual(result.draft?.images, Array.from({ length: 5 }, () => image));
 assert.equal(session.id, sessionId); assert.equal(session.sessionFile, sessionFile);
 assert.equal((await session.getMessages()).some(message => message.nativeId === user), false);
 const firstTicket = result.state.ticket;
 const substituted = session.startPrompt("Substituted images forbidden", { treeTicket: firstTicket, commandVersion: 23, commandId: "substitute", images: [] });
 await assert.rejects(substituted.accepted, /preserve|images/); await substituted.completion.catch(() => {});
 const run = session.startPrompt("Revised five-image question", { treeTicket: firstTicket, commandVersion: 23, commandId: "worker-edit" });
 const accepted = await run.accepted; await run.completion;
 assert.equal(accepted?.kind, "user-message"); assert.equal(accepted?.images?.length, 5);
 const after = await SessionManager.open(sessionFile);
 assert.ok(originalIds.every(id => after.getEntry(id)), "all original native branch entries retained");
 const submitted = after.getEntry(accepted!.entryId!);
 assert.ok(submitted?.type === "message" && submitted.message.role === "user" && Array.isArray(submitted.message.content));
 assert.equal(submitted.message.content.filter(part => part.type === "image").length, 5);
 const replay = session.startPrompt("Must not duplicate", { treeTicket: firstTicket, commandVersion: 23, commandId: "worker-replay" });
 await assert.rejects(replay.accepted, /branch changed/); await replay.completion.catch(() => {});
 const current = await session.getTree();
 await session.mutateTree("old-branch", { sessionId, ticket: current.ticket, mutation: { action: "navigate", targetId: oldTail!, summarize: false } });
 const selected = (await session.getTree()).leafId;
 await session.dispose(); session = await runtime.open({ sessionFile, interactions: true, approvalOverride: "yolo" });
 const reopenedTree = await session.getTree();
 assert.ok(reopenedTree.entries.find(entry => entry.id === selected)?.active, "native session_exit may extend, but cannot replace the selected branch");
 assert.ok(reopenedTree.entries.find(entry => entry.id === oldTail)?.active); assert.equal(reopenedTree.entries.find(entry => entry.id === accepted!.entryId)?.active, false); assert.equal(session.id, sessionId);
 const second = await session.mutateTree("held-edit", { sessionId, ticket: (await session.getTree()).ticket, mutation: { action: "navigate", targetId: user, summarize: false } });
 await writeFile(path.join(root, "hold-prompt"), "1");
 const held = session.startPrompt("Stopped during native before-agent hook", { treeTicket: second.state.ticket, commandVersion: 23, commandId: "held-prompt" });
 for (let attempt = 0; ; attempt++) { try { await readFile(path.join(root, "prompt-entered")); break; } catch { if (attempt > 1000) throw new Error("Native before-agent hook not entered"); await Bun.sleep(5); } }
 const stopping = session.abort();
 await Bun.sleep(25); await writeFile(path.join(root, "release-prompt"), "1");
 const stoppedAdmission = await held.accepted.catch(() => null); assert.equal(stoppedAdmission, null); await held.completion.catch(() => {}); await stopping;
 const stopped = await SessionManager.open(sessionFile);
 assert.ok(!JSON.stringify(stopped.getEntries()).includes("Stopped during native before-agent hook"));
 console.log(JSON.stringify({ sameNativeSession: sessionId === session.id, originalHistoryPreserved: true, nativeImages: 5, clientSubstitutionRejected: true, staleReplayRejected: true, restartBranchPreserved: true, heldNativePromptStop: true, provider: "controlled-local-code-no-inference" }));
} finally { await session.dispose(); await runtime.dispose(); }
