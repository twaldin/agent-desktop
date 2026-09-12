import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { WorkspaceService, GitCheckoutBlockedError } from "../../../host/src/workspace/service";
import { checkoutRefusalResult } from "../../../host/src/checkout-refusal";
import { HostStore } from "../../../host/src/store";
import { WorkspaceState } from "./workspace-state";
import { readGitCheckoutRefusal } from "../../../../packages/shared/src/checkout-refusal";
import type { CommandEnvelope, CommandResult, DesktopBridge } from "../../../../packages/shared/src/protocol";
import type { WorkspaceMutation } from "../../../../packages/shared/src/workspace-protocol";
import type { OfflineCache } from "./offline-cache";
import { requestHost } from "../main/host-transport";
import { requestVersionedCommand } from "../main/command-endpoints";

const stores = new Set<HostStore>();
afterEach(() => { for (const store of stores) store.close(); stores.clear(); });
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
function environment(cwd: string) { return { PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" }; }
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { env: environment(cwd), stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(result.stderr.toString());
  return result.stdout.toString().trimEnd();
}
async function fixture() {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), "agent-checkout-conflict-"))); roots.push(cwd);
  const hooks = join(cwd, "hooks"); await mkdir(hooks);
  git(cwd, "init", "--initial-branch=main"); git(cwd, "config", "user.name", "Conflict Fixture");
  git(cwd, "config", "user.email", "fixture@example.invalid"); git(cwd, "config", "commit.gpgSign", "false");
  git(cwd, "config", "core.hooksPath", hooks);
  await writeFile(join(cwd, "tracked"), "base\n"); git(cwd, "add", "tracked"); git(cwd, "commit", "-m", "base");
  git(cwd, "switch", "-c", "topic"); await writeFile(join(cwd, "tracked"), "topic\n");
  await writeFile(join(cwd, "incoming"), "incoming\n"); git(cwd, "add", "tracked", "incoming"); git(cwd, "commit", "-m", "topic");
  const target = git(cwd, "rev-parse", "HEAD"); git(cwd, "switch", "main");
  git(cwd, "remote", "add", "origin", join(cwd, "never-contacted")); git(cwd, "update-ref", "refs/remotes/origin/remote-topic", target);
  const service = new WorkspaceService(cwd);
  const original = (service as any).git.bind(service);
  (service as any).git = (args: string[], options: any = {}) => original(args, { ...options, env: { ...environment(cwd), ...options.env } });
  const snapshot = async () => ({ index: (await readFile(join(cwd, ".git/index"))).toString("base64"),
    head: await readFile(join(cwd, ".git/HEAD"), "utf8"), config: await readFile(join(cwd, ".git/config"), "utf8"),
    reflog: await readFile(join(cwd, ".git/logs/HEAD"), "utf8"), refs: git(cwd, "for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)"),
    tracked: await readFile(join(cwd, "tracked"), "utf8"), incoming: await readFile(join(cwd, "incoming"), "utf8").catch(() => undefined) });
  return { cwd, hooks, target, service, snapshot };
}

async function transportFixture() {
  const f = await fixture(), directory = await mkdtemp(join(tmpdir(), "agent-refusal-store-")); roots.push(directory);
  let store = new HostStore(directory); stores.add(store);
  const hostId = store.host.id, project = store.addProject({ path: f.cwd }), target = { projectId: project.id };
  let executions = 0, drop = false, failWrites = false, failAfterReply = false;
  const deliveries: CommandEnvelope[] = [], owners: string[] = [], values = new Map<string, string>();
  const cache: OfflineCache = { read: async key => values.get(key) ?? null, write: async (key, value) => {
    if (failWrites) throw new Error("controlled acknowledgement failure"); values.set(key, value);
  } };
  const bridge = {
    workspaceQuery: async (owner, query, host) => {
      expect(host).toBe(hostId); expect(owner).toEqual(target);
      if (query.type === "git.status") return { type: query.type, status: await f.service.gitStatus() };
      if (query.type === "git.branches") return { type: query.type, branches: await f.service.branches() };
      if (query.type === "git.worktrees") return { type: query.type, worktrees: await f.service.worktrees() };
      if (query.type === "files.list") return { type: query.type, path: query.path, entries: [] };
      throw new Error(`Unexpected query ${query.type}`);
    },
    command: async (envelope, host) => {
      owners.push(host!); deliveries.push(structuredClone(envelope));
      expect(host).toBe(hostId); if (envelope.command.type !== "workspace.mutate") throw new Error("Unexpected command");
      expect(envelope.command.target).toEqual(target);
      const hash = createHash("sha256").update(JSON.stringify(envelope.command)).digest("hex"), claim = store.claimCommand(envelope.id, hash);
      if (claim.kind === "done") return JSON.parse(JSON.stringify(claim.record.result));
      if (claim.kind !== "claimed") throw new Error(`Unexpected claim ${claim.kind}`);
      let result: CommandResult;
      try {
        const action = envelope.command.action; if (action.type !== "git.checkout") throw new Error("Unexpected mutation");
        executions++;
        result = { ok: true, commandId: envelope.id, value: { type: action.type, status: await f.service.checkout(action.branch, action.expectedRevision, action.create) } };
      } catch (cause) {
        result = checkoutRefusalResult(envelope.id, envelope.command, cause)
          ?? { ok: false, commandId: envelope.id, error: { code: "COMMAND_FAILED", message: String(cause) } };
      }
      result = store.finishCommand(envelope.id, hash, result).result!;
      if (failAfterReply) { failAfterReply = false; failWrites = true; }
      if (drop) { drop = false; throw new Error("Reply lost after durable refusal"); }
      return JSON.parse(JSON.stringify(result));
    },
    subscribe: () => () => {},
  } satisfies Pick<DesktopBridge, "workspaceQuery" | "command" | "subscribe">;
  const data = new WorkspaceState(bridge, hostId, target, cache); data.setConnected(true); await data.restore();
  return { ...f, data, bridge, cache, target, deliveries, owners, hostId, values, executions: () => executions,
    command: async () => ({ type: "git.checkout", branch: "topic", expectedRevision: (await f.service.gitStatus()).revision } as const),
    drop: () => { drop = true; }, failAfterReply: () => { failAfterReply = true; }, allowWrites: () => { failWrites = false; },
    reopen: () => { store.close(); stores.delete(store); store = new HostStore(directory); stores.add(store); },
    recorded: (id: string) => store.getCommand(id)?.result };
}

test("structured refusal survives JSON, durable host reopen and original-ID retry without a second checkout", async () => {
  const f = await transportFixture(); await writeFile(join(f.cwd, "tracked"), "retained edit\n"); const before = await f.snapshot();
  f.drop(); await f.data.mutate(await f.command());
  const id = f.data.pending!.envelope.id;
  expect(f.data.pending?.uncertain).toBe(true); expect(f.data.checkoutRefusal).toBeUndefined(); expect(f.executions()).toBe(1);
  f.reopen();
  const recovered = new WorkspaceState(f.bridge, f.hostId, f.target, f.cache); recovered.setConnected(true); await recovered.restore();
  expect(recovered.pending?.envelope.id).toBe(id); await recovered.retry();
  expect(recovered.pending).toBeUndefined();
  expect(recovered.checkoutRefusal).toMatchObject({ commandId: id, action: { type: "git.checkout", branch: "topic" },
    error: { code: "GIT_CHECKOUT_BLOCKED", checkoutConflict: { conflictedPaths: ["tracked"] } } });
  expect(f.recorded(id)).toMatchObject({ ok: false, commandId: id, error: recovered.checkoutRefusal!.error });
  expect(f.deliveries.map(item => item.id)).toEqual([id, id]); expect(f.executions()).toBe(1); expect(await f.snapshot()).toEqual(before);
});

test("failed local acknowledgement keeps the original request and withholds the continuation signal", async () => {
  const f = await transportFixture(); await writeFile(join(f.cwd, "tracked"), "retained edit\n");
  f.failAfterReply(); await f.data.mutate(await f.command()); const id = f.deliveries[0]!.id;
  expect(f.data.pending).toMatchObject({ envelope: { id }, uncertain: true }); expect(f.data.checkoutRefusal).toBeUndefined();
  expect(f.data.cacheWarning).toContain("could not be saved"); expect(f.executions()).toBe(1);
  f.allowWrites(); await f.data.retry();
  expect(f.data.pending).toBeUndefined(); expect(f.data.checkoutRefusal?.commandId).toBe(id); expect(f.executions()).toBe(1);
});

test("host projection is confined to the typed checkout failure and parser clones display paths", () => {
  const cause = new GitCheckoutBlockedError("blocked", ['"quoted\\tpath"']);
  const command = { type: "workspace.mutate" as const, target: { projectId: "p" }, action: { type: "git.checkout" as const, branch: "topic", expectedRevision: "r" } };
  const result = checkoutRefusalResult("id", command, cause)!;
  expect(result).toMatchObject({ ok: false, commandId: "id", error: { checkoutConflict: { conflictedPaths: ['"quoted\\tpath"'] } } });
  cause.conflictedPaths.push("later"); if (result.ok) throw new Error("Expected refusal");
  expect(result.error.checkoutConflict?.conflictedPaths).toHaveLength(1);
  expect(checkoutRefusalResult("id", { ...command, action: { type: "git.stage", paths: [] } }, cause)).toBeUndefined();
  expect(checkoutRefusalResult("id", command, Object.assign(new Error("blocked"), { code: cause.code, conflictedPaths: [] }))).toBeUndefined();
  expect(readGitCheckoutRefusal({ code: "COMMAND_FAILED", message: "would be overwritten by checkout" })).toBeUndefined();
  expect(readGitCheckoutRefusal({ code: "OUTCOME_UNKNOWN", checkoutConflict: { conflictedPaths: ["tracked"] } })).toBeUndefined();
  expect(readGitCheckoutRefusal({ code: "GIT_CHECKOUT_BLOCKED", message: "blocked", checkoutConflict: { conflictedPaths: [] } })).toBeDefined();
});

test("malformed, foreign-command and wrong-action refusals retain uncertain original commands", async () => {
  const errors = [
    { code: "GIT_CHECKOUT_BLOCKED", message: "blocked" },
    { code: "GIT_CHECKOUT_BLOCKED", message: "blocked", checkoutConflict: { conflictedPaths: [3] } },
    { code: "GIT_CHECKOUT_BLOCKED", message: "blocked", checkoutConflict: { conflictedPaths: [""] } },
  ];
  for (const error of errors) {
    const f = await transportFixture(); f.bridge.command = async envelope => ({ ok: false, commandId: envelope.id, error } as CommandResult);
    await f.data.mutate(await f.command()); expect(f.data.pending?.uncertain).toBe(true); expect(f.data.checkoutRefusal).toBeUndefined(); expect(f.executions()).toBe(0);
  }
  for (const mismatch of ["id", "action"]) {
    const f = await transportFixture();
    f.bridge.command = async envelope => ({ ok: false, commandId: mismatch === "id" ? "other" : envelope.id,
      error: { code: "GIT_CHECKOUT_BLOCKED", message: "blocked", checkoutConflict: { conflictedPaths: ["tracked"] } } });
    const action: WorkspaceMutation = mismatch === "action" ? { type: "git.stage", paths: ["tracked"] } : await f.command();
    await f.data.mutate(action); expect(f.data.pending?.uncertain).toBe(true); expect(f.data.checkoutRefusal).toBeUndefined(); expect(f.executions()).toBe(0);
  }
});

test("new admitted action clears the old current-owner refusal without mutating the saved action", async () => {
  const f = await transportFixture(); await writeFile(join(f.cwd, "tracked"), "edit\n"); const action: Extract<WorkspaceMutation, { type: "git.checkout" }> = { ...await f.command() };
  await f.data.mutate(action); const refusal = f.data.checkoutRefusal!; action.branch = "elsewhere";
  expect(refusal.action).toMatchObject({ branch: "topic" });
  await writeFile(join(f.cwd, "tracked"), "base\n"); await f.data.mutate(await f.command());
  expect(f.data.checkoutRefusal).toBeUndefined(); expect(f.data.mutationReceipt?.value).toMatchObject({ type: "git.checkout", status: { branch: "topic" } });
  expect(f.executions()).toBe(2);
});

test("checkout admission captures the exact action before awaiting the native response", async () => {
  const f = await transportFixture(); await writeFile(join(f.cwd, "tracked"), "edit\n");
  let start!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { start = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  const command = f.bridge.command;
  f.bridge.command = async (envelope, host) => { start(); await held; return command(envelope, host); };
  const action: Extract<WorkspaceMutation, { type: "git.checkout" }> = { ...await f.command() };
  const pending = f.data.mutate(action); await started; action.branch = "never-submitted"; release(); await pending;
  expect(f.deliveries[0]?.command).toMatchObject({ action: { branch: "topic" } });
  expect(f.data.checkoutRefusal?.action).toMatchObject({ branch: "topic" }); expect(f.executions()).toBe(1);
});

test("main HTTP command transport preserves refusal data in a successful HTTP response", async () => {
  const envelope: CommandEnvelope = { id: "receipt", command: { type: "workspace.mutate", target: { projectId: "p" },
    action: { type: "git.checkout", branch: "topic", expectedRevision: "revision" } } };
  const result = checkoutRefusalResult(envelope.id, envelope.command, new GitCheckoutBlockedError("blocked", ["tracked"]))!;
  const previous = globalThis.fetch; let calls = 0;
  globalThis.fetch = (async (input, init) => {
    calls++; expect(String(input)).toBe("http://fixture.invalid/v1/commands"); expect(init?.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual(envelope);
    return Response.json(result);
  }) as typeof fetch;
  try {
    const received = await requestVersionedCommand((path, body) => requestHost({ origin: "http://fixture.invalid", hostId: "host" }, path, body), envelope);
    expect(received).toEqual(result); expect(calls).toBe(1);
  } finally { globalThis.fetch = previous; }
});
