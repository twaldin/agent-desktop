// Actual OMP session/agent/storage; the asynchronous entry into its steer API
// is held deliberately. No external provider transport or credentials are used.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
globalThis.fetch = Object.assign(async () => { throw new Error("No outbound transport in image cancellation contract"); }, { preconnect() {} }) as typeof fetch;
const { NativeSteerAdmission } = await import(process.env.IMAGE_STEER_MODULE ?? "../omp/steer");
const { createAgentSession, SessionManager, Settings, AgentRegistry } = await import("@oh-my-pi/pi-coding-agent");
const root = process.argv[2]!, cwd = path.join(root, "project"), agentDir = path.join(root, "agent"), gates = path.join(root, "gates");
await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(gates)]);
process.env.IMAGE_CONTRACT_GATES = gates;
await writeFile(path.join(gates, "mode"), "hold");
await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("../omp-workers/fixtures/image-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
const manager = SessionManager.create(cwd, path.join(root, "sessions"));
const { session } = await createAgentSession({ cwd, agentDir, sessionManager: manager, agentRegistry: new AgentRegistry(),
  settings: await Settings.loadReadOnly({ cwd, agentDir }), hasUI: false });
await session.setModel(session.modelRegistry.getAll().find(model => model.provider === "image-contract" && model.id === "vision")!);
const admission = new NativeSteerAdmission(session, manager);
const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
const originalSteer = session.steer.bind(session);
session.steer = async (...args) => { entered.resolve(); await release.promise; return originalSteer(...args); };
let prompt: Promise<boolean> | undefined;
try {
  prompt = session.prompt("original held turn");
  const deadline = Date.now() + 7000;
  while (!await Bun.file(path.join(gates, "provider-input.json")).exists() && Date.now() < deadline) await Bun.sleep(5);
  assert(await Bun.file(path.join(gates, "provider-input.json")).exists(), "actual initial provider callback");
  const data = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/hZkAAAAASUVORK5CYII=", "base64");
  const queued = admission.start("cancelled image", "steer", [{ data, attachment: { id: "image", hostId: "private", kind: "image",
    name: "capture.png", bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex"), mimeType: "image/png" } }]);
  await entered.promise;
  admission.cancelQueued("explicit stop during image preparation");
  await session.abort(); await prompt;
  assert.equal((await queued.completion).kind, "not-recorded");
  let drained = false;
  const drain = admission.settleCancelled("stopped native image").then(() => { drained = true; });
  await new Promise<void>(resolve => setImmediate(resolve));
  const premature = drained;
  release.resolve(); await drain;
  assert.equal(premature, false, "drain must retain the original asynchronous native call");
  assert.deepEqual(session.agent.peekSteeringQueue(), []);
  assert.deepEqual(session.agent.peekFollowUpQueue(), []);
  await manager.flush();
  const rows = (await readFile(manager.getSessionFile()!, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  assert.deepEqual(rows.filter(row => row.message?.role === "user").map(row => row.message.content[0].text), ["original held turn"]);
  console.log("actual image follow-up cancellation retained native dispatch and prevented replay");
} finally {
  release.resolve(); admission.cancelQueued("fixture cleanup"); await session.abort(); await prompt?.catch(() => {});
  await admission.settleCancelled("fixture cleanup"); admission.close(); await session.dispose();
}
