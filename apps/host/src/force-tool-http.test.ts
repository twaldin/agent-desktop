import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { startHost } from "./server";
import { SESSION_FORCE_TOOL_OWNER_HEADER, parseForceToolResponse } from "../../../packages/shared/src/force-tool";
import type { CommandEnvelope, CommandResult } from "@agent-desktop/shared";

/** Real host/journal/worker/native force gate. Only filesystem persistence is
 * delayed/crashed; no provider is called and no force setter/queue is replaced. */
test("two HTTP clients join one arm, reject changed IDs/stale tickets, retain edited drafts and never replay orphaned worker intent", async () => {
  const root = await mkdtemp(join(tmpdir(), "force-http-native-"));
  const agentDirectory = join(root, "agent"), discoveryDirectory = join(root, "project"), gates = join(root, "gates");
  await Promise.all([agentDirectory, discoveryDirectory, gates].map(path => mkdir(path)));
  const provider = join(root, "provider.ts"), workerPath = join(root, "worker.ts");
  await writeFile(provider, `export default function(pi) {
    pi.registerProvider("force-http", { api: "openai-completions", baseUrl: "https://controlled.invalid", apiKey: "inert-force-fixture",
      models: [{ id: "controlled", name: "Controlled native force", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }] });
  }`);
  await writeFile(join(agentDirectory, "config.yml"), `extensions:\n  - ${JSON.stringify(provider)}\ndefaultThinkingLevel: off\nretry:\n  enabled: false\n`);
  await writeFile(workerPath, `process.env.HOME = ${JSON.stringify(root)};
    process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(agentDirectory)};
    globalThis.fetch = Object.assign(async () => { throw new Error("Provider calls are forbidden in force HTTP admission gates"); }, { preconnect() {} });
    // These imports intentionally occur after installing the isolated environment
    // and outbound guard; static imports would execute native startup too early.
    const { SessionManager } = await import(${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-coding-agent"))});
    const { existsSync, writeFileSync } = await import("node:fs");
    const gates = ${JSON.stringify(gates)};
    const original = SessionManager.prototype.flush;
    SessionManager.prototype.flush = async function() {
      const entries = this.getBranch().filter(entry => entry.type === "custom" && entry.customType === "agent-desktop.force-tool");
      const last = entries.at(-1)?.data?.forceToolReceipt?.commandId;
      if (last && existsSync(gates + "/" + last + ".hold")) {
        writeFileSync(gates + "/" + last + ".started", String(process.pid));
        while (existsSync(gates + "/" + last + ".hold")) await Bun.sleep(5);
      }
      if (last && existsSync(gates + "/" + last + ".crash")) process.exit(73);
      return original.call(this);
    };
    await import(${JSON.stringify(new URL("./omp-workers/entry.ts", import.meta.url).href)});`);
  const host = await startHost({ dataDirectory: join(root, "data"), agentDirectory, discoveryDirectory, workerPath, port: 0, tailscale: false });
  const headers = { Authorization: `Bearer ${host.connection.token}`, "Content-Type": "application/json" };
  const submit = async (envelope: CommandEnvelope): Promise<CommandResult> => {
    const response = await fetch(`${host.connection.origin}/v18/commands`, { method: "POST", headers, body: JSON.stringify(envelope) });
    expect(response.status).toBe(200); return response.json() as Promise<CommandResult>;
  };
  // This coordinates a separate real worker process's filesystem fence; fake
  // timers in this test process cannot advance that worker or its IPC delivery.
  const waitStarted = async (id: string) => {
    const deadline = Date.now() + 10_000;
    while (!await Bun.file(join(gates, `${id}.started`)).exists()) {
      if (Date.now() > deadline) throw new Error("Native force history boundary was not reached");
      await Bun.sleep(10);
    }
  };
  try {
    const created = await submit({ id: "create", commandVersion: 18, command: { type: "session.create", projectId: null, cwd: discoveryDirectory, model: { provider: "force-http", id: "controlled" } } });
    if (!created.ok || !created.value || !("sessionFile" in created.value)) throw new Error("Native session creation failed");
    const session = created.value;
    const readState = async (commandId?: string) => {
      const response = await fetch(`${host.connection.origin}/v1/sessions/${session.id}/force-tool${commandId ? `?commandId=${commandId}` : ""}`, {
        headers: { ...headers, [SESSION_FORCE_TOOL_OWNER_HEADER]: host.store.host.id },
      });
      expect(response.status).toBe(200);
      return parseForceToolResponse(await response.json(), host.store.host.id, session.id, commandId);
    };
    const unauthenticated = await fetch(`${host.connection.origin}/v1/sessions/${session.id}/force-tool`, { headers: { [SESSION_FORCE_TOOL_OWNER_HEADER]: host.store.host.id } });
    expect(unauthenticated.status).toBe(401);
    const before = (await readState()).value!;
    const tool = before.tools.find(tool => tool.available)!.name;
    const draft = host.store.putDraft({ id: `session:${session.id}`, text: `/force ${tool}`, projectId: null, model: null }, 0);
    if (!draft.ok) throw new Error("Draft setup failed");
    const envelope: CommandEnvelope = { id: "original", commandVersion: 18, command: { type: "session.prompt", sessionId: session.id, text: draft.draft.text,
      forceTool: { epoch: before.epoch, expectedRevision: before.revision, toolName: tool }, draft: { id: draft.draft.id, revision: draft.draft.revision } } };
    await writeFile(join(gates, "original.hold"), "hold native persistence");
    const first = submit(envelope); await waitStarted("original");
    const duplicate = submit(envelope);
    const changed = await submit({ ...envelope, command: { ...envelope.command, text: `/force ${tool} different` } as typeof envelope.command });
    expect(changed).toMatchObject({ ok: false, error: { code: "COMMAND_ID_REUSED" } });
    const pending = await readState("original");
    expect(pending.receipt?.state).toBe("pending"); expect(pending.value?.directives).toHaveLength(1);
    const edited = host.store.putDraft({ id: draft.draft.id, text: "New unsent edits", projectId: null, model: null }, draft.draft.revision);
    expect(edited.ok).toBe(true);
    const staleClient = submit({ ...envelope, id: "stale-client" });
    await rm(join(gates, "original.hold"));
    const [one, two, stale] = await Promise.all([first, duplicate, staleClient]);
    expect(one).toEqual(two); expect(one).toMatchObject({ ok: true, forceToolReceipt: { arm: "armed", prompt: "not-requested" } });
    expect(stale.ok).toBe(false);
    expect(host.store.getDraft(draft.draft.id)?.text).toBe("New unsent edits");
    const entries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(entries.filter(entry => entry.customType === "agent-desktop.force-tool" && entry.data.forceToolReceipt.commandId === "original")).toHaveLength(1);
    const after = (await readState()).value!;
    await submit({ id: "cancel", commandVersion: 18, command: { type: "session.force.cancel", sessionId: session.id,
      ticket: { epoch: after.epoch, revision: after.revision }, directiveId: after.directives[0]!.id } });
    expect((await readState()).value?.directives).toEqual([]);
    await writeFile(join(gates, "lost.crash"), "exit at native history flush");
    const lost = await submit({ id: "lost", commandVersion: 18, command: { type: "session.prompt", sessionId: session.id, text: `/force ${tool}` } });
    expect(lost).toMatchObject({ ok: false, error: { code: "OUTCOME_UNKNOWN" } });
    const lostRead = await readState("lost");
    expect(lostRead.value).toBeNull(); expect(lostRead.receipt?.state).toBe("unknown");
    // Host-restart equivalent durable pending claim, with no active command map.
    const orphan = { type: "session.prompt" as const, sessionId: session.id, text: `/force ${tool}` };
    host.store.claimCommand("orphan", createHash("sha256").update(JSON.stringify(orphan)).digest("hex"), orphan);
    expect(await submit({ id: "orphan", commandVersion: 18, command: orphan })).toMatchObject({ ok: false, error: { code: "OUTCOME_UNKNOWN" } });
    expect((await readState("orphan")).receipt?.state).toBe("unknown");
    expect((await readState("never-submitted")).receipt?.state).toBe("absent");
  } finally { await rm(join(gates, "original.hold"), { force: true }); await host.stop(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
