// Actual pinned SDK and native JSONL, under a test-owned HOME and agent dir.
// Block network/preconnect before loading native modules; never infer a response.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent";
import type { OmpSession } from "../runtime";

let blockedFetches = 0;
globalThis.fetch = Object.assign(async () => {
  blockedFetches++;
  throw new Error("Outbound fetch is disabled in the thinking persistence contract");
}, { preconnect: () => {} }) as typeof fetch;

const directory = process.argv[2]!;
const mode = process.argv[3] ?? "auto";
const agentDir = path.join(directory, ".omp", "agent"), cwd = path.join(directory, "project");
await mkdir(agentDir, { recursive: true });
await mkdir(cwd, { recursive: true });
const config = "extensions: []\ndefaultThinkingLevel: auto\nmodelRoles:\n  default: [openai-codex/gpt-5.4-mini:max]\n";
await writeFile(path.join(agentDir, "config.yml"), config);
const { AgentRegistry, createAgentSession, discoverAuthStorage, ModelRegistry, SessionManager, Settings } = await import("@oh-my-pi/pi-coding-agent");
const auth = await discoverAuthStorage(agentDir);
try { auth.upsertCredential("openai-codex", { type: "api_key", key: "thinking-contract-inert-key" }); }
finally { auth.close(); }
const { OmpRuntime } = await import("../runtime");
const runtime = new OmpRuntime({ agentDir });
const entries = async (file: string) => (await readFile(file, "utf8")).trim().split("\n").map(line => JSON.parse(line));
const snapshot = async (session: OmpSession) => ({ id: session.id, model: session.model, thinkingLevel: session.thinkingLevel,
  thinkingEntries: (await entries(session.sessionFile)).filter(entry => entry.type === "thinking_level_change") });
const mini = { provider: "openai-codex", id: "gpt-5.4-mini" };

async function nativeSession(file?: string) {
  const storage = await discoverAuthStorage(agentDir);
  try {
    const settings = await Settings.loadReadOnly({ agentDir, cwd });
    // No classifier model is available in this one contract: native
    // classification must use its unchanged-high fallback, with no request.
    if (mode === "unchanged") settings.override("modelRoles", {
      ...settings.get("modelRoles"), tiny: "unconfigured/no-classifier", smol: "unconfigured/no-classifier",
    });
    const registry = new ModelRegistry(storage, path.join(agentDir, "models.yml"), { settings });
    const manager = file ? await SessionManager.open(file) : SessionManager.create(cwd, path.join(agentDir, "sessions"));
    try {
      const result = await createAgentSession({ agentDir, cwd, settings, authStorage: storage, modelRegistry: registry,
        agentRegistry: new AgentRegistry(), sessionManager: manager, model: file ? undefined : registry.find(mini.provider, mini.id),
        hasUI: false, interactivePrompts: false, deferUsageReserveConfirmation: true });
      await manager.ensureOnDisk();
      return { session: result.session, manager, close: async () => { try { await result.session.dispose(); } finally { storage.close(); } } };
    } catch (error) { await manager.close(); throw error; }
  } catch (error) { storage.close(); throw error; }
}

try {
  let file: string, before: unknown;
  const details: Record<string, unknown> = {};
  if (mode === "legacy") {
    // Generate the old missing-receipt case through the unmodified native SDK;
    // do not forge or delete history entries to manufacture a legacy session.
    const native = await nativeSession();
    file = native.manager.getSessionFile()!;
    before = { id: native.session.sessionId, thinkingLevel: native.session.configuredThinkingLevel(),
      thinkingEntries: (await entries(file)).filter(entry => entry.type === "thinking_level_change") };
    await native.close();
  } else {
    const session = await runtime.create({ cwd, ...(mode === "role" ? {} : { model: mini }),
      ...(mode === "concrete" ? { thinkingLevel: "low" } : {}) });
    file = session.sessionFile;
    before = await snapshot(session);
    if (mode === "edits") {
      let controls = await session.getControls();
      const states = [];
      for (const level of ["auto", "xhigh", "auto", "auto", "low"]) {
        controls = await session.mutateControls({ operation: "thinking", level, expectedRevision: controls.revision });
        states.push(await snapshot(session));
      }
      details.edits = states;
    }
    await session.dispose();
  }
  if (mode === "unchanged") {
    const native = await nativeSession(file);
    const resolutions: Array<Extract<AgentSessionEvent, { type: "thinking_level_changed" }>> = [];
    const dropped: string[] = [];
    native.session.setPromptDropped(prompt => { dropped.push(prompt.text); });
    let abort: Promise<void> | undefined;
    native.session.subscribe(event => {
      if (event.type === "thinking_level_changed") {
        resolutions.push(event);
        // Abort synchronously at the real native resolution event, before the
        // user input can reach agent.prompt or any provider transport.
        abort = native.session.abort();
      }
    });
    try {
      const completed = [];
      for (let index = 0; index < 2; index++) {
        completed.push(await native.session.prompt("Isolated unchanged auto thinking contract"));
        await abort;
      }
      details.resolutions = resolutions;
      details.completed = completed;
      details.dropped = dropped;
      details.messageCount = (await entries(file)).filter(entry => entry.type === "message").length;
    } finally { await native.close(); }
  }
  const reopened = await runtime.open({ sessionFile: file });
  const after = await snapshot(reopened);
  await reopened.dispose();
  process.stdout.write(JSON.stringify({ before, after, ...details, blockedFetches,
    configUnchanged: await readFile(path.join(agentDir, "config.yml"), "utf8") === config }) + "\n");
} finally { await runtime.dispose(); }
