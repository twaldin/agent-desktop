// Actual native write-tool approval in a disposable project; no model involved.
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } from "@oh-my-pi/pi-coding-agent";
import { initializeDesktopExtensions } from "../../omp/extensions";
import { OmpInteractionBridge } from "../../omp/interactions";
globalThis.fetch = Object.assign(async () => { throw new Error("Provider fetch forbidden in permission contract"); }, { preconnect: () => {} }) as typeof fetch;
const [agentDir, cwd] = process.argv.slice(2);
const settings = await Settings.loadReadOnly({ agentDir, cwd });
const auth = await discoverAuthStorage(agentDir);
const manager = SessionManager.create(cwd, path.join(agentDir, "sessions"));
let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
const ui = new OmpInteractionBridge(manager.getSessionId(), () => {});
try {
  const result = await createAgentSession({ agentDir, cwd, settings, authStorage: auth,
    modelRegistry: new ModelRegistry(auth, path.join(agentDir, "models.yml"), { settings }),
    agentRegistry: new AgentRegistry(), sessionManager: manager, hasUI: false, interactivePrompts: true });
  session = result.session;
  result.setToolUIContext(ui, true);
  await initializeDesktopExtensions(session, ui);
  const write = session.agent.state.tools.find(tool => tool.name === "write");
  assert(write, "The actual native write tool must exist");
  const file = path.join(cwd, "permission-contract.txt");
  const waitForPermission = async () => {
    for (let i = 0; i < 100; i++) {
      const request = ui.list()[0];
      if (request) return request;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("Native tool did not request approval");
  };
  const denied = write.execute("contract-denied", { path: file, content: "must not be written" }, undefined, undefined, session.buildAskReanswerContext(ui));
  void denied.catch(() => {});
  const permission = await waitForPermission();
  assert.deepEqual(permission.options?.map(option => option.label), ["Approve", "Deny"]);
  await assert.rejects(access(file));
  ui.respond(permission.id, { value: "Deny" });
  await assert.rejects(denied, /denied by user/);
  await assert.rejects(access(file));
  const approved = write.execute("contract-approved", { path: file, content: "native tool wrote after explicit approval\n" }, undefined, undefined, session.buildAskReanswerContext(ui));
  const allowed = await waitForPermission();
  await assert.rejects(access(file));
  ui.respond(allowed.id, { value: "Approve" });
  await approved;
  assert.equal(await readFile(file, "utf8"), "native tool wrote after explicit approval\n");
  assert.equal(ui.list().length, 0);
  process.stdout.write("actual native write denied then explicitly approved\n");
} finally { ui.dispose(); await session?.dispose(); auth.close(); }
