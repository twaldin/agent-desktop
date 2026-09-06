import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "./runtime";

async function askFixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-native-ask-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./fixtures/ask-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" } });
  const close = async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); };
  try {
    const session = await runtime.create({ cwd, interactions: true });
    await session.setModel({ provider: "ask-contract", id: "controlled" });
    return { root, session, close };
  } catch (error) {
    await close();
    throw error;
  }
}

async function waitFor(session: Awaited<ReturnType<typeof askFixture>>["session"], method: "select" | "editor") {
  for (let index = 0; index < 500; index++) {
    const interaction = (await session.listInteractions())[0];
    if (interaction?.method === method) return interaction;
    await Bun.sleep(5);
  }
  const entries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const failure = entries.find(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === "ask");
  throw new Error(`Native ask never requested ${method}: ${failure?.message?.content?.[0]?.text ?? "no native tool result"}`);
}

test("a model-invoked native ask crosses the headless bridge and completes with option and free-text answers", async () => {
  const { session, close } = await askFixture();
  try {
    const run = session.startPrompt("Use the native ask tool"); await run.accepted;
    const first = await waitFor(session, "select");
    expect(first.title).toContain("Choose a color");
    expect(first.options?.some(option => option.label === "Blue (Recommended)" && option.description === "Cool tone")).toBe(true);
    await session.respondInteraction(first.id, { value: "Blue (Recommended)" });
    const second = await waitFor(session, "select"); expect(second.title).toContain("Add a detail");
    const other = second.options?.find(option => option.label.startsWith("Other"))?.label;
    expect(other).toBeTruthy(); await session.respondInteraction(second.id, { value: other! });
    const editor = await waitFor(session, "editor"); expect(editor.promptStyle).toBe(true);
    await session.respondInteraction(editor.id, { value: "Use rounded corners" });
    expect(await run.completion).toBe(true);
    expect(await session.listInteractions()).toEqual([]);
    const entries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const result = entries.find(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === "ask");
    expect(result?.message.content?.[0]?.text).toContain("Blue");
    expect(result?.message.content?.[0]?.text).toContain("Use rounded corners");
    expect(entries.some(entry => entry.type === "message" && entry.message?.role === "assistant"
      && entry.message.content?.some((part: { text?: string }) => part.text === "Native ask completed."))).toBe(true);
  } finally { await close(); }
}, 30_000);

test("captured nullable optional ask fields retain the real options", async () => {
  const { session, close } = await askFixture();
  try {
    const run = session.startPrompt("Use the captured nullable ask payload"); await run.accepted;
    const density = await waitFor(session, "select");
    expect(density.title).toContain("Which density?");
    expect(density.options?.map(option => option.label).slice(0, 2)).toEqual(["Comfortable", "Compact"]);
    await session.respondInteraction(density.id, { value: "Compact" });
    expect(await run.completion).toBe(true);
    const entries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    const result = entries.find(entry => entry.type === "message" && entry.message?.role === "toolResult" && entry.message?.toolName === "ask");
    expect(result?.message.content?.[0]?.text).toContain("Compact");
  } finally { await close(); }
}, 30_000);
