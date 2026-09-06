import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { OmpRuntime } from "./runtime";

test("configured extension providers appear in discovery and support direct model session creation", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-extension-provider-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), countFile = path.join(root, "factory-count");
  await Promise.all([mkdir(agentDir), mkdir(cwd)]);
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("../omp-workers/fixtures/ask-provider.ts", import.meta.url)))}\nretry:\n  enabled: false\n`);
  const previousCount = process.env.OMP_EXTENSION_FACTORY_COUNT;
  process.env.OMP_EXTENSION_FACTORY_COUNT = countFile;
  const runtime = new OmpRuntime({ agentDir });
  try {
    const catalog = await runtime.getComposerCatalog(cwd, { refresh: true });
    expect(catalog.models.some(model => model.provider === "ask-contract" && model.id === "controlled")).toBe(true);
    const discoveryFactories = (await readFile(countFile, "utf8")).trim().split("\n").filter(Boolean).length;
    const session = await runtime.create({ cwd, model: { provider: "ask-contract", id: "controlled" }, interactions: true });
    try {
      expect((await readFile(countFile, "utf8")).trim().split("\n").filter(Boolean)).toHaveLength(discoveryFactories + 1);
      const waitFor = async (method: string, title?: string) => {
        for (let attempt = 0; attempt < 500; attempt++) {
          const interaction = (await session.listInteractions())[0];
          if (interaction?.method === method && (!title || interaction.title.includes(title))) return interaction;
          await Bun.sleep(5);
        }
        throw new Error(`Native extension interaction did not arrive: ${method}`);
      };
      const run = session.startPrompt("Use the native ask tool"); await run.accepted;
      const first = await waitFor("select", "Choose a color");
      await session.respondInteraction(first.id, { value: first.options!.find(option => option.label.startsWith("Blue"))!.label });
      const second = await waitFor("select", "Add a detail");
      await session.respondInteraction(second.id, { value: second.options!.find(option => option.label.startsWith("Other"))!.label });
      const editor = await waitFor("editor");
      await session.respondInteraction(editor.id, { value: "Use rounded corners" });
      expect(await run.completion).toBe(true);
      expect(await readFile(session.sessionFile, "utf8")).toContain("Native ask completed.");
    } finally { await session.dispose(); }
  } finally { await runtime.dispose(); if (previousCount === undefined) delete process.env.OMP_EXTENSION_FACTORY_COUNT; else process.env.OMP_EXTENSION_FACTORY_COUNT = previousCount; await rm(root, { recursive: true, force: true }); }
}, 30_000);
