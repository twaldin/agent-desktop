import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_SLASH_COMMANDS_INTERNAL } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { WorkerRuntime } from "./runtime";
import { skillInsertionIssue } from "@agent-desktop/shared";
import { parseSkillInvocation } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { hasNativeBtwComposerWinner } from "../omp/composer-actions";

async function fixture(worker = "no-provider-worker.ts") {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-desktop-native-composer-")));
  const agentDir = path.join(root, "agent"), cwd = path.join(root, "project"), gates = path.join(root, "gates");
  await Promise.all([agentDir, cwd, gates, path.join(cwd, ".omp", "skills", "compose-skill")].map(p => mkdir(p, { recursive: true })));
  await writeFile(path.join(cwd, ".omp", "skills", "compose-skill", "SKILL.md"), "---\nname: compose-skill\ndescription: Controlled native skill\n---\nUse NATIVE_SKILL_BODY with the supplied arguments.\n");
  await writeFile(path.join(cwd, "file with spaces.txt"), "Reference contents stay on the owner");
  await writeFile(path.join(agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(fileURLToPath(new URL("./fixtures/composer-provider.ts", import.meta.url)))}\ndefaultThinkingLevel: off\nretry:\n  enabled: false\n`);
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL(`./fixtures/${worker}`, import.meta.url)),
    environment: { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, IMAGE_CONTRACT_GATES: gates, TERM: "dumb" } });
  return { root, agentDir, cwd, gates, runtime, close: async () => { await runtime.dispose(); await rm(root, { recursive: true, force: true }); } };
}

test("native read-only catalog lists the complete builtin registry without executing registration factories or creating history", async () => {
  const f = await fixture();
  try {
    const catalog = await f.runtime.getComposerActions(f.cwd, { refresh: true });
    expect(catalog.commands.filter(row => row.source.kind === "builtin").map(row => row.name)).toEqual(BUILTIN_SLASH_COMMANDS_INTERNAL.map(row => row.name));
    expect(catalog.commands.filter(row => row.source.kind === "builtin").map(row => row.aliases)).toEqual(BUILTIN_SLASH_COMMANDS_INTERNAL.map(row => row.aliases ? [...row.aliases] : undefined));
    expect(catalog.referenceSchemes).toEqual(InternalUrlRouter.instance().completionSchemes());
    expect(catalog.skills.find(row => row.name === "compose-skill")).toMatchObject({ availability: "executable", insertText: "/skill:compose-skill " });
    expect(catalog.commands.find(row => row.source.path?.endsWith("composer-provider.ts"))).toMatchObject({ availability: "pending", insertText: "" });
    expect(catalog.commands.find(row => row.id === "builtin:btw")).toMatchObject({ availability: "partial", desktopAction: "side-chat" });
    expect(hasNativeBtwComposerWinner(catalog)).toBe(true);
    expect(await Bun.file(path.join(f.gates, "factory-ran")).exists()).toBe(false);
    expect(await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan({ cwd: f.root }))).toHaveLength(0);
    const files = await f.runtime.getComposerCompletions(f.cwd, { kind: "file", query: "file", catalogRevision: catalog.revision });
    expect(files.items.find(row => row.label.includes("file with spaces"))?.insertText).toBe('@"file with spaces.txt" ');
    expect(JSON.stringify(files)).not.toContain("Reference contents");
  } finally { await f.close(); }
}, 30_000);

test("native skill inventory includes master and name-disabled skills without changing the normal catalog", async () => {
  const f = await fixture();
  try {
    const extension = fileURLToPath(new URL("./fixtures/composer-provider.ts", import.meta.url));
    await writeFile(path.join(f.agentDir, "config.yml"), `extensions:\n  - ${JSON.stringify(extension)}\ndisabledExtensions:\n  - skill:compose-skill\nskills:\n  enabled: false\n  enableSkillCommands: false\n`);
    const inventory = await f.runtime.getSkillInventory(f.cwd, { refresh: true });
    expect(inventory).toMatchObject({ enabled: false, commandsEnabled: false, skills: [{ name: "compose-skill", disabledByName: true, availability: "disabled" }] });
    expect(inventory.skills[0]?.reason).toContain("skills.enabled");
    const ordinary = await f.runtime.getComposerActions(f.cwd, { refresh: true });
    expect(ordinary.skills).toEqual([]);
    for (const filter of ['ignoredSkills: [compose-skill]', 'includeSkills: [different-name]', 'enablePiProject: false']) {
      await writeFile(path.join(f.agentDir, "config.yml"), `extensions: []\nskills:\n  enabled: false\n  ${filter}\n`);
      expect((await f.runtime.getSkillInventory(f.cwd, { refresh: true })).skills).toEqual([]);
    }
    expect(await Bun.file(path.join(f.gates, "factory-ran")).exists()).toBe(false);
    expect(await Array.fromAsync(new Bun.Glob("**/*.jsonl").scan({ cwd: f.root }))).toHaveLength(0);
  } finally { await f.close(); }
}, 30_000);

test("actual native loaded callbacks, collisions, builtin output, unsupported commands and post-effect uncertainty", async () => {
  const f = await fixture();
  try {
    const session = await f.runtime.create({ cwd: f.cwd, interactions: true });
    const catalog = await session.getComposerActions();
    expect(catalog.commands.find(row => row.id === "builtin:btw")).toMatchObject({ availability: "partial", desktopAction: "side-chat" });
    expect(hasNativeBtwComposerWinner(catalog)).toBe(true);
    expect(await Bun.file(path.join(f.gates, "factory-ran")).exists()).toBe(true);
    expect(catalog.commands.find(row => row.id === "builtin:jobs")?.availability).toBe("shadowed");
    expect(catalog.commands.find(row => row.name === "jobs:detail")?.availability).toBe("executable");
    const query = { kind: "command-argument" as const, commandName: "compose-test", query: 'first "partial', catalogRevision: catalog.revision };
    expect((await session.getComposerCompletions(query)).items[0]?.insertText).toBe('chosen first "partial');
    expect((await session.getComposerCompletions({ ...query, query: "throw" })).diagnostics).toEqual(["Native argument completion failed: Controlled completion exception"]);
    expect((await session.getComposerCompletions({ kind: "command-argument", commandName: "session", query: "i", catalogRevision: catalog.revision })).items[0]).toMatchObject({ label: "info", insertText: "info " });
    const command = session.startPrompt("/compose-test exact args");
    expect(await command.accepted).toEqual({ kind: "native-command", command: "compose-test" }); expect(await command.completion).toBe(false);
    expect(await readFile(path.join(f.gates, "executed"), "utf8")).toBe("exact args");
    const info = session.startPrompt("/session info");
    const infoReceipt = await info.accepted;
    expect(infoReceipt?.kind).toBe("native-command"); await info.completion;
    if (infoReceipt?.kind !== "native-command" || !infoReceipt.entryId || !infoReceipt.output) throw new Error("Expected persisted native command output receipt");
    expect(infoReceipt.command).toBe("session"); expect(typeof infoReceipt.entryId).toBe("string"); expect(infoReceipt.output).toContain(session.id);
    expect((await session.getMessages()).find(row => row.id === infoReceipt.entryId)?.commandOutput).toEqual({
      entryId: infoReceipt.entryId, command: "session", output: infoReceipt.output,
    });
    const sessionFile = session.sessionFile;
    await session.dispose();
    const reopened = await f.runtime.open({ sessionFile, interactions: true });
    expect((await reopened.getMessages()).find(row => row.id === infoReceipt.entryId)?.commandOutput).toEqual({
      entryId: infoReceipt.entryId, command: "session", output: infoReceipt.output,
    });
    for (const text of ["/new", "/usage reset", "/no-such-native-command", "/session delete"]) {
      const run = reopened.startPrompt(text); await expect(run.accepted).rejects.toThrow("not"); await expect(run.completion).rejects.toThrow();
    }
    expect(await Bun.file(path.join(f.gates, "provider-input.json")).exists()).toBe(false);
    const effect = reopened.startPrompt("/effect-throw");
    await expect(effect.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" }); await expect(effect.completion).rejects.toThrow();
    expect(await readFile(path.join(f.gates, "effect"), "utf8")).toBe("actual effect");
    expect((await reopened.getMessages()).filter(row => row.role === "user")).toHaveLength(0);
  } finally { await f.close(); }
}, 30_000);

test("leading and inline skill selection invoke real native skill custom history, flush and reopen identity", async () => {
  const f = await fixture();
  try {
    const session = await f.runtime.create({ cwd: f.cwd, interactions: true });
    for (const text of ["/skill:compose-skill arguments", "Prose before /skill:compose-skill and after"]) {
      const run = session.startPrompt(text, { model: { provider: "image-contract", id: "text" } }), receipt = await run.accepted;
      expect(receipt).toMatchObject({ kind: "skill-message", name: "compose-skill" }); await run.completion;
      if (receipt?.kind !== "skill-message") throw new Error("Expected actual skill entry receipt");
      const entries = (await readFile(session.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(entries.find(row => row.id === receipt.entryId)).toMatchObject({ type: "custom_message", customType: "skill-prompt", attribution: "user", content: expect.stringContaining("NATIVE_SKILL_BODY") });
      expect((await session.getMessages()).find(row => row.nativeId === receipt.entryId)?.text).toContain("NATIVE_SKILL_BODY");
    }
    const before = (await session.getMessages()).map(row => ({ id: row.id, nativeId: row.nativeId, text: row.text }));
    await session.dispose();
    const opened = await f.runtime.open({ sessionFile: session.sessionFile });
    expect((await opened.getMessages()).map(row => ({ id: row.id, nativeId: row.nativeId, text: row.text }))).toEqual(before);
    expect(before.filter(row => row.text.includes("NATIVE_SKILL_BODY"))).toHaveLength(2);
  } finally { await f.close(); }
}, 30_000);

test("skill flush failure retains honest uncertain receipt and insertion gate matches pinned parser exclusions", async () => {
  const f = await fixture("image-failure-worker.ts");
  try {
    const session = await f.runtime.create({ cwd: f.cwd });
    await writeFile(path.join(f.gates, "fail-flush"), "");
    const run = session.startPrompt("/skill:compose-skill arguments", { model: { provider: "image-contract", id: "text" } });
    await expect(run.accepted).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" }); await expect(run.completion).rejects.toThrow();
    await rm(path.join(f.gates, "fail-flush"));
    for (const before of ["/other ", "! ", "$ ", "$$ "]) {
      expect(skillInsertionIssue(before)).toBeTruthy(); expect(parseSkillInvocation(`${before}/skill:compose-skill `)).toBeUndefined();
    }
    for (const before of ["", "plain prose "]) {
      expect(skillInsertionIssue(before)).toBeUndefined(); expect(parseSkillInvocation(`${before}/skill:compose-skill `)?.name).toBe("compose-skill");
    }
  } finally { await f.close(); }
}, 30_000);

test("native skill identity follows its file through refreshed metadata, invalidity and repair", async () => {
  const f = await fixture();
  try {
    const before = await f.runtime.getSkillInventory(f.cwd, { refresh: true });
    const original = before.skills.find(skill => skill.name === "compose-skill")!;
    expect(original).toBeDefined();
    const contents = await readFile(original.source.path!, "utf8");
    await writeFile(original.source.path!, contents.replace("description: Controlled native skill", "description: Refreshed native skill metadata"));
    const changed = await f.runtime.getSkillInventory(f.cwd, { refresh: true });
    expect(changed.skills.find(skill => skill.name === "compose-skill")).toMatchObject({
      id: original.id, description: "Refreshed native skill metadata", source: { path: original.source.path },
    });
    expect(changed.revision).not.toBe(before.revision);

    await writeFile(original.source.path!, "---\nname: compose-skill\n---\nMissing required description\n");
    const invalid = await f.runtime.getSkillInventory(f.cwd, { refresh: true });
    expect(invalid.skills.find(skill => skill.source.path === original.source.path)).toBeUndefined();

    await writeFile(original.source.path!, contents);
    const repaired = await f.runtime.getSkillInventory(f.cwd, { refresh: true });
    expect(repaired.skills.find(skill => skill.name === "compose-skill")).toMatchObject({
      id: original.id, description: "Controlled native skill", source: { path: original.source.path },
    });
  } finally { await f.close(); }
});
