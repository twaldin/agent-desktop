import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { NativeTerminalInfo, NativeTerminalInvalidation } from "../../../packages/shared/src/terminals";
import type { PreparedPlanExternalEditor } from "./omp/plan-external-editor";
import { PlanEditorTerminals } from "./plan-editor-terminal";
import { TmuxTerminalManager } from "./terminals/native-manager";

const roots: Array<{ path: string; manager?: TmuxTerminalManager }> = [];
const bundle = process.env.AGENT_TEST_TMUX_BUNDLE;
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const environment = (): Record<string, string> => Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]]));
afterEach(async () => { for (const item of roots.splice(0).reverse()) { await item.manager?.shutdown().catch(() => {}); rmSync(item.path, { recursive: true, force: true }); } });
function root(): string { const path = realpathSync(mkdtempSync(join(tmpdir(), "agent-plan-editor-terminal-"))); chmodSync(path, 0o700); roots.push({ path }); return path; }
function prepared(cwd: string, editorCommand = "/usr/bin/true"): PreparedPlanExternalEditor {
  const sessionId = crypto.randomUUID();
  return { request: { requestId: crypto.randomUUID(), controlEpoch: crypto.randomUUID(), sessionId,
    ticket: { epoch: "epoch", nativeSessionId: "native", revision: "a".repeat(64) }, reviewId: "review",
    reviewRevision: "b".repeat(64), documentRevision: "document", edit: { kind: "plan" } },
    nativeSessionId: "native", sessionFile: join(cwd, "session.jsonl"), cwd, content: "original\n", extension: ".md",
    trimTrailingNewline: false, editorCommand, environment: { ...environment(), VISUAL: editorCommand } };
}

class FakeTerminals {
  listeners = new Set<(event: NativeTerminalInvalidation) => void>();
  closeCalls = 0;
  info?: NativeTerminalInfo;
  async createOwnedCommand(input: { target: { sessionId: string }; cwd: string }, _command: unknown,
    reservation: { terminalId: string; validateOwner(): void }): Promise<NativeTerminalInfo> {
    reservation.validateOwner();
    this.info = { id: reservation.terminalId, target: input.target, cwd: input.cwd, shell: "bun", pid: 123, cols: 120, rows: 40,
      status: "running", createdAt: Date.now(), protocol: "tmux-v1", serverGeneration: crypto.randomUUID(), geometryRevision: 1,
      inputEpoch: crypto.randomUUID() };
    return structuredClone(this.info);
  }
  get(id: string): NativeTerminalInfo { if (!this.info || this.info.id !== id) throw new Error("missing"); return structuredClone(this.info); }
  subscribe(listener: (event: NativeTerminalInvalidation) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async close(id: string): Promise<NativeTerminalInfo> {
    this.closeCalls++;
    if (!this.info || this.info.id !== id) throw new Error("missing");
    this.info = { ...this.info, status: "exited", exitedAt: Date.now(), cancelled: true };
    for (const listener of this.listeners) listener({ type: "state", terminal: structuredClone(this.info) });
    return structuredClone(this.info);
  }
}

test("cleanup waits for verified settlement and recovery preservation removes only private inputs and scratch", async () => {
  const directory = root(), fake = new FakeTerminals(), terminals = new PlanEditorTerminals(directory, fake);
  const input = prepared(directory), run = await terminals.start(crypto.randomUUID(), input, () => {});
  expect(() => run.cleanup()).toThrow("still owns");
  await run.cancel(); expect(await run.completion).toEqual({ version: 1, outcome: "cancelled" });
  run.cleanup({ preserveEditedResult: true });
  const manifest = JSON.parse(readFileSync(join(directory, "plan-editors-v1", input.request.requestId, "files.json"), "utf8"));
  expect([manifest.files.inputPath, manifest.files.contentPath, manifest.files.scratchPath].some(existsSync)).toBe(false);
});

test("restart recovery refuses changed terminal identity and malformed manifests without dispatching close", async () => {
  const directory = root(), fake = new FakeTerminals(), first = new PlanEditorTerminals(directory, fake);
  const input = prepared(directory), terminalId = crypto.randomUUID(), run = await first.start(terminalId, input, () => {});
  const original = structuredClone(fake.info!); fake.info = { ...fake.info!, createdAt: fake.info!.createdAt + 1 };
  const reopened = new PlanEditorTerminals(directory, fake);
  await expect(reopened.cancelOriginal(input.request.requestId, terminalId)).rejects.toThrow("not the original");
  expect(fake.closeCalls).toBe(0);
  fake.info = original; await fake.close(terminalId); await expect(run.completion).resolves.toEqual({ version: 1, outcome: "cancelled" });
  const manifestPath = join(directory, "plan-editors-v1", input.request.requestId, "files.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")); manifest.untrusted = true; writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  expect(() => reopened.recovery(input.request.requestId)).toThrow("index is invalid");
});

describe.skipIf(!bundle)("actual original private pane after adapter reconstruction", () => {
  test("cancels the acknowledged original terminal and never launches a replacement", async () => {
    const directory = root(), data = join(directory, "data"), editor = join(directory, "editor.sh"); mkdirSync(data, { mode: 0o700 });
    writeFileSync(editor, `#!/bin/sh\necho $$ > editor-pid\nwhile :; do sleep 10; done\n`, { mode: 0o700 });
    const manager = await TmuxTerminalManager.open({ dataDirectory: data, hostId: crypto.randomUUID(), bundleDirectory: resolve(bundle!), pollIntervalMs: 100 });
    roots.find(item => item.path === directory)!.manager = manager;
    const input = prepared(directory, quote(editor)), terminalId = crypto.randomUUID();
    const original = new PlanEditorTerminals(data, manager), run = await original.start(terminalId, input, () => {});
    const pidPath = join(directory, "editor-pid"), end = Date.now() + 10_000;
    while (!existsSync(pidPath)) { if (Date.now() > end) throw new Error("Timed out waiting for the controlled editor."); await Bun.sleep(20); }
    const before = manager.get(terminalId);
    const reopened = new PlanEditorTerminals(data, manager);
    await reopened.cancelOriginal(input.request.requestId, terminalId);
    expect(manager.get(terminalId)).toMatchObject({ id: terminalId, createdAt: before.createdAt, serverGeneration: before.serverGeneration,
      status: "exited", cancelled: true });
    expect(await run.completion).toEqual({ version: 1, outcome: "cancelled" });
    run.cleanup();
  }, 20_000);
});
