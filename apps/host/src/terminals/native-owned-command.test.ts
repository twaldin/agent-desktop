import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Process, ProcessStatus } from "@oh-my-pi/pi-natives";
import { cleanupPlanEditorProcessFiles, createPlanEditorProcessFiles, planEditorProcessCommand, readPlanEditorProcessResult } from "../plan-editor-process";
import { TmuxTerminalManager } from "./native-manager";

const bundle = process.env.AGENT_TEST_TMUX_BUNDLE;
const roots: Array<{ path: string; manager?: TmuxTerminalManager }> = [];
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const environment = (extra: Record<string, string>): Record<string, string> => ({
  ...Object.fromEntries(Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [[key, value]])), ...extra,
});
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await Bun.sleep(20); }
}
afterEach(async () => { for (const item of roots.splice(0).reverse()) { await item.manager?.shutdown().catch(() => {}); rmSync(item.path, { recursive: true, force: true }); } });

async function fixture(editorBody: string, options: { trimTrailingNewline?: boolean } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agent-plan-editor-process-"))), data = join(root, "data"), jobs = join(root, "jobs"), temp = join(root, "tmp");
  for (const path of [data, jobs, temp]) mkdirSync(path, { mode: 0o700 });
  const editor = join(root, "editor.sh"); writeFileSync(editor, editorBody); chmodSync(editor, 0o700);
  const manager = await TmuxTerminalManager.open({ dataDirectory: data, hostId: crypto.randomUUID(), bundleDirectory: resolve(bundle!), pollIntervalMs: 100 });
  roots.push({ path: root, manager });
  const selected = quote(editor);
  const files = createPlanEditorProcessFiles(jobs, { editorCommand: selected, content: "original\n", extension: ".md", trimTrailingNewline: options.trimTrailingNewline ?? false });
  const command = planEditorProcessCommand(files, environment({ VISUAL: selected, EDITOR: "must-not-run", TMPDIR: temp, PLAN_EDITOR_SECRET: "private-marker" }));
  const terminalId = crypto.randomUUID(), target = { sessionId: crypto.randomUUID() };
  const terminal = await manager.createOwnedCommand({ cwd: root, target, cols: 80, rows: 24 }, command, { terminalId, validateOwner() {} });
  return { root, data, jobs, temp, editor, manager, files, terminal, terminalId, target };
}

describe.skipIf(!bundle)("host-owned command pane with actual native OMP editor helper", () => {
  test("edits through a real attached PTY, retains no command environment, and observes natural completion", async () => {
    const f = await fixture(`#!/bin/sh
if test -t 0 && test -t 1; then tty=true; else tty=false; fi
printf '{"stdin":%s,"stdout":%s,"visual":"set","editor":"%s","tmp":"%s"}' "$tty" "$tty" "$EDITOR" "$TMPDIR" > editor-ready.json
dd bs=1 count=1 >/dev/null 2>&1
printf 'changed through PTY\\n' > "$1"
`);
    const payload = join(f.data, "native-terminals-v1", `environment-launch-${f.terminalId}.sh`);
    await until(() => existsSync(join(f.root, "editor-ready.json")), "controlled editor ready");
    expect(statSync(payload).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(f.root, "editor-ready.json"), "utf8")).toContain('"stdin":true');
    expect(readFileSync(join(f.root, "editor-ready.json"), "utf8")).toContain('"stdout":true');
    expect(readFileSync(join(f.root, "editor-ready.json"), "utf8")).toContain(`"tmp":"${f.files.scratchPath}"`);
    expect(readFileSync(join(f.data, "native-terminals-v1", "catalog.json"), "utf8")).not.toContain("private-marker");
    const attachment = await f.manager.attach(f.terminalId, crypto.randomUUID());
    f.manager.heartbeat(attachment.id, 0, attachment.geometryRevision);
    const receipt = await f.manager.input({ terminalId: f.terminalId, attachmentId: attachment.id, inputEpoch: attachment.inputEpoch,
      geometryRevision: attachment.geometryRevision, clientId: crypto.randomUUID(), sequence: 1, input: { kind: "text", data: "x\n" } });
    expect(receipt.outcome).toBe("accepted");
    await until(() => f.manager.get(f.terminalId).status === "exited", "editor helper exit");
    expect(f.manager.get(f.terminalId)).toMatchObject({ status: "exited", exitCode: 0 });
    expect(f.manager.get(f.terminalId).cancelled).toBeUndefined();
    expect(readPlanEditorProcessResult(f.files)).toMatchObject({ outcome: "completed", content: "changed through PTY\n" });
    await until(() => !existsSync(payload), "private environment payload cleanup");
    expect(existsSync(payload)).toBe(false);
    expect(readdirSync(f.temp).filter(name => name.startsWith("omp-editor-"))).toEqual([]);
    cleanupPlanEditorProcessFiles(f.files);
  }, 20_000);

  test("native editor nonzero is a definite cancellation and trims no plan bytes", async () => {
    const f = await fixture(`#!/bin/sh
exit 7
`);
    await until(() => f.manager.get(f.terminalId).status === "exited", "cancelled editor helper exit");
    expect(f.manager.get(f.terminalId)).toMatchObject({ status: "exited", exitCode: 0 });
    expect(readPlanEditorProcessResult(f.files)).toEqual({ version: 1, outcome: "cancelled" });
    expect(readdirSync(f.temp).filter(name => name.startsWith("omp-editor-"))).toEqual([]);
  });

  test("explicit close drains the pane editor process and records cancellation without a fabricated result", async () => {
    const f = await fixture(`#!/bin/sh
echo $$ > editor-pid
while :; do sleep 10; done
`);
    await until(() => existsSync(join(f.root, "editor-pid")), "blocking editor pid");
    const editorPid = Number(readFileSync(join(f.root, "editor-pid"), "utf8"));
    expect(Process.fromPid(editorPid)?.status()).toBe(ProcessStatus.Running);
    const closed = await f.manager.close(f.terminalId);
    expect(closed).toMatchObject({ status: "exited", cancelled: true });
    await until(() => Process.fromPid(editorPid)?.status() !== ProcessStatus.Running, "editor child termination");
    expect(readPlanEditorProcessResult(f.files)).toBeUndefined();
    expect(existsSync(join(f.data, "native-terminals-v1", `environment-launch-${f.terminalId}.sh`))).toBe(false);
  }, 15_000);
});
