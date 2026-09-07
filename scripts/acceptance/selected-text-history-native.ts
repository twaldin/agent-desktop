import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkerRuntime } from "../../apps/host/src/omp-workers/runtime";

// Real pinned SDK and worker IPC; the allowlisted local provider echoes its
// actual model context. The worker fixture rejects outbound provider fetches.
const repo = resolve(import.meta.dir, "../.."), output = resolve(process.argv[2] ?? `.data/selected-text-history-native-${Date.now()}`);
await mkdir(output, { recursive: true, mode: 0o700 });
if ((await readdir(output)).length) throw new Error("Output must be empty");
const sources = ["apps/host/src/omp/selected-text.ts", "apps/host/src/omp/selected-text-history.ts", "apps/host/src/omp/prompt.ts", "apps/host/src/omp/runtime.ts", "apps/host/src/omp-workers/runtime.ts", "apps/host/src/omp-workers/protocol.ts", "apps/host/src/omp-workers/fixtures/no-provider-worker.ts", "apps/host/src/omp-workers/fixtures/selected-text-provider.ts", "scripts/acceptance/selected-text-history-native.ts"];
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(join(repo, file))).digest("hex")])));
const before = await hashes(), root = await mkdtemp(join(tmpdir(), "selected-history-native-")), agent = join(root, "agent"), gates = join(root, "gates");
const runtime = new WorkerRuntime({ agentDir: agent, workerPath: join(repo, "apps/host/src/omp-workers/fixtures/no-provider-worker.ts"), environment: {
  HOME: root, TMPDIR: root, PATH: "/usr/bin:/bin:/usr/sbin:/sbin", PI_DISABLE_DOTENV: "1", PI_CODING_AGENT_DIR: agent, SELECTED_TEXT_CONTRACT_GATES: gates,
} });
try {
  await mkdir(agent); await mkdir(gates);
  await writeFile(join(agent, "config.yml"), `extensions:\n  - ${JSON.stringify(join(repo, "apps/host/src/omp-workers/fixtures/selected-text-provider.ts"))}\nretry:\n  enabled: false\n`);
  await writeFile(join(root, "mentioned.txt"), "ACTUAL_FILE_MENTION_VALUE");
  const session = await runtime.create({ cwd: root });
  const selected = { submissionId: "actual-native-history", attachments: [{ id: "snapshot", text: "unsaved captured value", source: { kind: "file" as const, hostId: "another-host", path: "/missing/source.ts", range: { start: { line: 1, column: 1 }, end: { line: 1, column: 23 } } } }] };
  const run = session.startPrompt("Explain this and @mentioned.txt", { model: { provider: "selected-text-contract", id: "controlled" }, selectedText: selected });
  const receipt = await run.accepted; await run.completion;
  const messages = await session.getMessages(), raw = await readFile(session.sessionFile, "utf8");
  await writeFile(join(output, "native-messages.json"), JSON.stringify(messages, null, 2));
  await writeFile(join(output, "native-raw.jsonl"), raw);
  const user = messages.find(message => message.nativeId === receipt?.entryId), answer = messages.find(message => message.role === "assistant");
  assert.ok(user?.selectedText?.bindingEntryId);
  assert.deepEqual(user.selectedText.attachments, selected.attachments);
  assert.equal(messages.some(message => message.role === "selectedText"), false);
  assert.ok(answer?.text.includes("ACTUAL_FILE_MENTION_VALUE"));
  const sessionFile = session.sessionFile;
  await session.dispose();
  const reopened = await runtime.open({ sessionFile });
  const restored = await reopened.getMessages(); await reopened.dispose();
  assert.deepEqual(restored.find(message => message.nativeId === receipt?.entryId)?.selectedText, user.selectedText);
  const after = await hashes(); assert.deepEqual(after, before);
  await writeFile(join(output, "result.json"), JSON.stringify({ passed: true, receipt, userNativeId: user.nativeId, bindingEntryId: user.selectedText.bindingEntryId,
    referenceSeen: true, reopened: true, sourceHashes: after, prompts: 1,
    scope: "Actual pinned OMP worker/SDK with controlled local provider, persisted metadata binding, ordinary @file context and native reopen. No hosted-provider, desktop, cross-device or pixel acceptance.",
  }, null, 2));
} catch (error) {
  await writeFile(join(output, "failure.json"), JSON.stringify({ passed: false, error: String(error) }, null, 2)); throw error;
} finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
