import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService } from "../../../host/src/workspace/service";
import { readGitActionContext } from "../../../host/src/workspace/git-action-context";
import type { CommandEnvelope, CommandResult, DesktopEvent } from "../../../../packages/shared/src/protocol";
import type { WorkspaceMutationResult, WorkspaceQueryResult } from "../../../../packages/shared/src/workspace-protocol";
import { WorkspaceState } from "./workspace-state";
import type { OfflineCache } from "./offline-cache";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function storage(): OfflineCache & { values: Map<string, string> } { const values = new Map<string, string>(); return { values, read: async key => values.get(key) ?? null, write: async (key, value) => { values.set(key, value); } }; }
function deferred() { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; }
async function fixture(standalone = false) {
  const path = await mkdtemp(join(tmpdir(), "agent-renderer-workspace-")); directories.push(path);
  const git = (...args: string[]) => { const result = Bun.spawnSync(["git", "-C", path, ...args]); if (result.exitCode !== 0) throw new Error(result.stderr.toString()); return result.stdout.toString().trim(); };
  git("init", "--initial-branch=main"); git("config", "user.name", "Workspace Test"); git("config", "user.email", "workspace-test@example.invalid");
  await writeFile(join(path, "sample.txt"), "original\n"); git("add", "sample.txt"); git("commit", "-m", "Fixture baseline");
  const native = new WorkspaceService(path, { worktreeRoot: join(path, ".managed-worktrees") });
  const receipts = new Map<string, CommandResult>(); const deliveries: CommandEnvelope[] = []; const owners: string[] = []; const listeners = new Set<(event: DesktopEvent) => void>();
  let before: (() => Promise<void>) | undefined; let drop = false;
  let heldRead: { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  const bridge = {
    workspaceQuery: async (_target: unknown, query: Parameters<ConstructorParameters<typeof WorkspaceState>[0]["workspaceQuery"]>[1], hostId?: string): Promise<WorkspaceQueryResult> => {
      owners.push(hostId!);
      switch (query.type) {
        case "git.submission": throw new Error("Compound submissions are exercised through the host journal fixture.");
        case "git.selection-summary": throw new Error("Selection summaries are exercised through the owner-fenced host query fixture.");
        case "file.copy-info": case "file.copy-chunk": case "file.open-options": case "environment.actions": case "environment.output": case "environment.preparation": case "environment.read": case "environments.list": throw new Error("Environment catalog is outside this file/Git fixture.");
        case "files.list": return { type: query.type, entries: await native.list(query.path) };
        case "files.search": return { type: query.type, ...await native.searchFiles(query.query, query.limit) };
        case "file.stat": return { type: query.type, entry: await native.stat(query.path) };
        case "file.read": {
          const content = await native.readText(query.path), held = heldRead; heldRead = undefined;
          if (held) { held.started.resolve(); await held.release.promise; }
          return { type: query.type, content };
        }
        case "git.status": return { type: query.type, status: await native.gitStatus() };
        case "git.action-context": return { type: query.type, context: await readGitActionContext(native) };
        case "git.diff": return { type: query.type, diff: await native.diff(query) };
        case "git.review-summary": return { type: query.type, summary: await native.reviewSummary(query.source) };
        case "git.branches": return { type: query.type, branches: await native.branches() };
        case "git.base-branch": return { type: query.type, base: await native.baseBranch() };
        case "git.default-branch": return { type: query.type, branch: await native.defaultBranch() };
        case "git.recent-branches": return { type: query.type, branches: await native.recentBranches(query.limit) };
        case "git.resolve-checkout": return { type: query.type, target: await native.resolveCheckoutTarget(query.expression) };
        case "git.resolve-revision": return { type: query.type, revision: await native.resolveRevision(query.expression) };
        case "git.search-starting-branches": return { type: query.type, ...await native.searchStartingBranches(query.query, query.limit) };
        case "git.search-branches": return { type: query.type, ...await native.searchBranches(query.query, query.limit) };
        case "git.worktrees": return { type: query.type, worktrees: await native.worktrees() };
      }
    },
    command: async (envelope: CommandEnvelope, hostId?: string): Promise<CommandResult> => {
      owners.push(hostId!); deliveries.push(envelope);
      const previous = receipts.get(envelope.id); if (previous) return previous;
      await before?.();
      if (envelope.command.type !== "workspace.mutate") throw new Error("Unexpected command");
      const action = envelope.command.action;
      let result: CommandResult;
      try {
        let value: WorkspaceMutationResult;
        switch (action.type) {
          case "git.submit": case "git.submit.cancel": case "git.submit.acknowledge": throw new Error("Compound submissions require the real host journal.");
          case "file.open": case "environment.action": case "environment.select": case "environment.save": throw new Error("Environment editing is outside this file/Git fixture.");
          case "file.write": value = { type: action.type, result: await native.writeText(action.path, action) }; break;
          case "git.stage": value = { type: action.type, status: await native.stage(action.paths) }; break;
          case "git.unstage": value = { type: action.type, status: await native.unstage(action.paths, action.expectedRevision) }; break;
          case "git.checkout-revision": value = { type: action.type, status: await native.checkoutRevision(action.revision, action.expectedRevision) }; break;
          case "git.checkout-ref": value = { type: action.type, status: await native.checkoutRef(action.selection, action.expectedRevision) }; break;
          case "git.checkout": value = { type:action.type, status: await native.checkout(action.branch,action.expectedRevision,action.create) }; break;
          case "git.commit": value = { type: action.type, ...await native.commit(action.message, action.expectedRevision) }; break;
          case "worktree.create": value = { type: action.type, worktree: await native.createWorktree(action.options) }; break;
          case "worktree.remove": throw new Error("Removal is covered through the host adapter's managed-path contract.");
        }
        result = { ok: true, commandId: envelope.id, value };
      } catch (cause) { result = { ok: false, commandId: envelope.id, error: { code: "COMMAND_FAILED", message: cause instanceof Error ? cause.message : String(cause) } }; }
      receipts.set(envelope.id, result);
      if (drop) { drop = false; throw new Error("Test transport disconnected after real native mutation"); }
      return result;
    },
    subscribe: (listener: (event: DesktopEvent) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const cache = storage(); const data = new WorkspaceState(bridge, "home", standalone ? {filePath: join(path, "sample.txt")} : { projectId: "project" }, cache, "home"); data.setConnected(true); await data.restore();
  return { path, git, native, bridge, cache, data, deliveries, owners, listeners, delay: (callback: () => Promise<void>) => { before = callback; },
    holdNextRead: () => { const held = { started: deferred(), release: deferred() }; heldRead = held; return held; }, dropNextReceipt: () => { drop = true; } };
}

describe("workspace renderer against actual file and Git services", () => {
  test("offline file-link reads preserve cached edits and reconnect checks the real host revision", async () => {
    const { path, data, owners, deliveries } = await fixture(true);
    try {
      await data.open("sample.txt"); data.edit("sample.txt", "unsaved local edit\n");
      const document = data.documents.get("sample.txt"), calls = owners.length;
      data.setConnected(false);
      await data.open("sample.txt"); await data.read("sample.txt");
      expect(data.documents.get("sample.txt")).toBe(document);
      expect(document?.text).toBe("unsaved local edit\n");
      expect(document?.dirty).toBe(true);
      expect(data.errors["file:sample.txt"]).toBeUndefined();
      expect(owners).toHaveLength(calls);
      await data.read("uncached.txt");
      expect(data.errors["file:uncached.txt"]).toContain("disconnected");
      expect(data.documents.has("uncached.txt")).toBe(false);
      expect(owners).toHaveLength(calls);
      await writeFile(join(path, "sample.txt"), "changed on host\n");
      data.setConnected(true); await data.read("sample.txt");
      expect(owners).toHaveLength(calls + 1);
      expect(document?.text).toBe("unsaved local edit\n");
      expect(document?.conflict).toMatchObject({kind:"text",text:"changed on host\n"});
      expect(deliveries).toHaveLength(0);
    } finally { data.stop(); }
  });

  test("breadcrumb reads cache folders without navigating the directory tab", async () => {
    const { path, data, owners, deliveries } = await fixture();
    await mkdir(join(path, "src")); await mkdir(join(path, "docs"));
    await writeFile(join(path, "docs", "guide.txt"), "guide\n");
    await data.list("src"); await data.open("sample.txt"); data.edit("sample.txt", "unsaved\n");
    await data.readDirectory("docs");
    expect(data.directories.get("docs")?.map(entry => entry.path)).toEqual(["docs/guide.txt"]);
    expect(data.directory).toBe("src"); expect(data.opened).toBe("sample.txt");
    expect(data.documents.get("sample.txt")?.text).toBe("unsaved\n");
    expect(data.documents.get("sample.txt")?.dirty).toBe(true);
    expect(owners.every(owner => owner === "home")).toBe(true); expect(deliveries).toHaveLength(0);
    data.stop();
  });

  test("branch checkout refreshes native files while preserving unsaved editor text", async () => {
    const f = await fixture();
    f.git("switch", "-c", "feature");
    await writeFile(join(f.path, "sample.txt"), "feature version\n");
    f.git("commit", "-am", "Feature file"); f.git("switch", "main");
    await f.data.open("sample.txt"); f.data.edit("sample.txt", "my unsaved editor buffer\n");
    await f.data.loadGit();
    await f.data.mutate({ type: "git.checkout", branch: "feature", expectedRevision: f.data.status!.revision });
    expect(f.git("branch", "--show-current")).toBe("feature");
    expect(f.data.status?.branch).toBe("feature");
    expect(f.data.documents.get("sample.txt")).toMatchObject({ text: "my unsaved editor buffer\n", dirty: true, conflict: { text: "feature version\n" } });
    expect(f.owners.every(owner => owner === "home")).toBe(true);
  });
  test("branch creation recovers a lost receipt without attempting another checkout", async () => {
    const f = await fixture(); await f.data.loadGit(); f.dropNextReceipt();
    await f.data.mutate({ type: "git.checkout", branch: "recovered-feature", create: true, expectedRevision: f.data.status!.revision });
    expect(f.git("branch", "--show-current")).toBe("recovered-feature");
    expect(f.data.pending?.uncertain).toBe(true);
    const original = f.deliveries[0]!;
    const next = new WorkspaceState(f.bridge, "home", { projectId: "project" }, f.cache, "home");
    await next.restore(); next.setConnected(true); await next.retry();
    expect(f.deliveries).toEqual([original, original]);
    expect(next.pending).toBeUndefined(); expect(next.errors.action).toBeUndefined();
    expect(next.status?.branch).toBe("recovered-feature");
    expect(next.notice).toBe("Switched to recovered-feature.");
  });
  test("ref checkout receipt restores the same selection and does not repeat the native switch", async () => {
    const f = await fixture(); await f.data.loadGit();
    const commit = f.git("rev-parse", "HEAD");
    f.git("remote", "add", "origin", join(f.path, "never-contacted"));
    f.git("update-ref", "refs/remotes/origin/topic", commit);
    await f.data.open("sample.txt"); f.data.edit("sample.txt", "unsent buffer\n");
    f.dropNextReceipt();
    const selection = { ref: "refs/remotes/origin/topic", commit, localBranch: "topic" };
    await f.data.mutate({ type: "git.checkout-ref", selection, expectedRevision: f.data.status!.revision });
    expect(f.data.pending?.uncertain).toBe(true);
    const original = f.deliveries[0]!;
    expect(original.command).toMatchObject({ action: { type: "git.checkout-ref", selection } });
    const next = new WorkspaceState(f.bridge, "home", { projectId: "project" }, f.cache, "home");
    await next.restore(); next.setConnected(true); await next.retry();
    expect(f.deliveries).toEqual([original, original]);
    expect(next.pending).toBeUndefined(); expect(next.status?.branch).toBe("topic");
    expect(next.notice).toBe("Switched to topic.");
    expect(next.documents.get("sample.txt")).toMatchObject({ text: "unsent buffer\n", dirty: true });
    expect(f.git("reflog", "--format=%gs").split("\n").filter(line => line.startsWith("checkout:"))).toHaveLength(1);
  });
  test("edits made during a real save survive its completion and following refresh", async () => {
    const f = await fixture(); await f.data.open("sample.txt"); f.data.edit("sample.txt", "submitted\n");
    const started = deferred(); const release = deferred(); f.delay(async () => { started.resolve(); await release.promise; });
    const saving = f.data.saveFile("sample.txt"); await started.promise; f.data.edit("sample.txt", "newer local edit\n"); release.resolve(); await saving;
    expect(await readFile(join(f.path, "sample.txt"), "utf8")).toBe("submitted\n");
    expect(f.data.documents.get("sample.txt")).toMatchObject({ text: "newer local edit\n", dirty: true, content: { text: "submitted\n" } });
    expect(f.data.documents.get("sample.txt")?.conflict).toBeUndefined();
  });
  test("a read captured before a confirmed save cannot replace the newly clean document", async () => {
    const f = await fixture(); await f.data.open("sample.txt");
    const held = f.holdNextRead(), stale = f.data.read("sample.txt"); await held.started.promise;
    f.data.edit("sample.txt", "saved version\n"); const saving = f.data.saveFile("sample.txt");
    while ((await readFile(join(f.path, "sample.txt"), "utf8")) !== "saved version\n") await Bun.sleep(5);
    while (!f.data.mutationReceipt) await Bun.sleep(5);
    held.release.resolve(); await stale;
    expect(f.data.documents.get("sample.txt")).toMatchObject({ text: "saved version\n", dirty: false, content: { text: "saved version\n" } });
    expect(f.data.documents.get("sample.txt")?.conflict).toBeUndefined();
    await saving; await f.data.read("sample.txt");
  });
  test("a pre-save read cannot invent a conflict against edits made after the submitted revision", async () => {
    const f = await fixture(); await f.data.open("sample.txt");
    const held = f.holdNextRead(), stale = f.data.read("sample.txt"); await held.started.promise;
    f.data.edit("sample.txt", "submitted\n");
    const commandStarted = deferred(), releaseCommand = deferred(); f.delay(async () => { commandStarted.resolve(); await releaseCommand.promise; });
    const saving = f.data.saveFile("sample.txt"); await commandStarted.promise; f.data.edit("sample.txt", "newer local edit\n"); releaseCommand.resolve();
    while ((await readFile(join(f.path, "sample.txt"), "utf8")) !== "submitted\n") await Bun.sleep(5);
    while (!f.data.mutationReceipt) await Bun.sleep(5);
    held.release.resolve(); await stale;
    expect(f.data.documents.get("sample.txt")).toMatchObject({ text: "newer local edit\n", dirty: true, content: { text: "submitted\n" } });
    expect(f.data.documents.get("sample.txt")?.conflict).toBeUndefined();
    await saving; await f.data.read("sample.txt");
  });
  test("host write conflicts preserve both versions and explicit use-host retains the previous buffer", async () => {
    const f = await fixture(); await f.data.open("sample.txt"); f.data.edit("sample.txt", "my unsaved text\n"); await writeFile(join(f.path, "sample.txt"), "another client\n"); await f.data.saveFile("sample.txt");
    expect(await readFile(join(f.path, "sample.txt"), "utf8")).toBe("another client\n");
    expect(f.data.documents.get("sample.txt")).toMatchObject({ text: "my unsaved text\n", dirty: true, conflict: { text: "another client\n" } });
    f.data.resolve("sample.txt", "remote"); expect(f.data.documents.get("sample.txt")).toMatchObject({ text: "another client\n", dirty: false, recoveredText: "my unsaved text\n" });
  });
  test("lost receipts recover across a new controller and retry exactly the same command", async () => {
    const f = await fixture(); await f.data.open("sample.txt"); f.data.edit("sample.txt", "accepted once\n"); f.dropNextReceipt(); await f.data.saveFile("sample.txt");
    expect(f.data.pending?.uncertain).toBe(true); const original = f.deliveries[0]!;
    const next = new WorkspaceState(f.bridge, "home", { projectId: "project" }, f.cache, "home"); await next.restore(); next.setConnected(true);
    expect(next.pending?.envelope.id).toBe(original.id); await next.retry();
    expect(f.deliveries).toHaveLength(2); expect(f.deliveries[1]).toEqual(original); expect(next.pending).toBeUndefined();
    expect(next.documents.get("sample.txt")).toMatchObject({ text: "accepted once\n", dirty: false });
  });
  test("recovery writes must succeed before any mutation is delivered", async () => {
    const f = await fixture(); await f.data.open("sample.txt"); f.data.edit("sample.txt", "must not send\n"); f.cache.write = async () => { throw new Error("Storage is full"); };
    await f.data.saveFile("sample.txt"); expect(f.deliveries).toHaveLength(0); expect(await readFile(join(f.path, "sample.txt"), "utf8")).toBe("original\n"); expect(f.data.cacheWarning).toContain("Storage is full");
  });
  test("offline editor changes recover without an automatic send", async () => {
    const f = await fixture(); await f.data.open("sample.txt"); f.data.setConnected(false); f.data.edit("sample.txt", "offline buffer\n"); await f.data.saveFile("sample.txt");
    const next = new WorkspaceState(f.bridge, "home", { projectId: "project" }, f.cache, "home"); await next.restore();
    expect(next.documents.get("sample.txt")).toMatchObject({ text: "offline buffer\n", dirty: true }); expect(f.deliveries).toHaveLength(0);
    next.setConnected(true); await next.refresh(); expect(f.deliveries).toHaveLength(0); expect(next.documents.get("sample.txt")?.text).toBe("offline buffer\n");
  });
  test("stale index revisions reject unstage and commit while preserving the commit message", async () => {
    const f = await fixture(); await f.data.loadGit(); const previous = f.data.status!.revision;
    await writeFile(join(f.path, "sample.txt"), "changed\n"); await f.native.stage(["sample.txt"]);
    await f.data.mutate({ type: "git.unstage", paths: ["sample.txt"], expectedRevision: previous }); expect(f.data.errors.action).toContain("changed since this review");
    f.data.setCommitMessage("Keep this message"); await f.data.mutate({ type: "git.commit", message: f.data.commitMessage, expectedRevision: previous });
    expect(f.data.commitMessage).toBe("Keep this message"); expect(f.git("log", "-1", "--format=%s")).toBe("Fixture baseline");
    await f.data.mutate({ type: "git.commit", message: f.data.commitMessage, expectedRevision: f.data.status!.revision });
    expect(f.git("log", "-1", "--format=%s")).toBe("Keep this message"); expect(f.data.commitMessage).toBe(""); expect(f.git("config", "user.email")).toBe("workspace-test@example.invalid");
  });
  test("actual untracked diffs and worktree branches are surfaced without fabricated state", async () => {
    const f = await fixture(); await writeFile(join(f.path, "untracked.txt"), "new file\n"); await f.data.showDiff("untracked.txt", false); expect(f.data.diff?.patch).toContain("+new file");
    await f.data.mutate({ type: "worktree.create", options: { path: "feature", newBranch: "renderer-feature" } }); await f.data.loadWorktrees();
    expect(f.data.worktrees.some(tree => tree.branch === "renderer-feature" && tree.managed)).toBe(true); expect(f.data.branches.some(branch => branch.name === "renderer-feature")).toBe(true);
  });
  test("a selected diff follows actual stage, commit, and external working-tree changes", async () => {
    const f = await fixture();
    await writeFile(join(f.path, "sample.txt"), "changed\n");
    await f.data.showDiff("sample.txt", false);
    expect(f.data.diff?.patch).toContain("+changed");
    await f.data.mutate({ type: "git.stage", paths: ["sample.txt"] });
    expect(f.data.diff?.patch).toBe("");
    await f.data.showDiff("sample.txt", true);
    expect(f.data.diff?.patch).toContain("+changed");
    await f.data.mutate({ type: "git.commit", message: "Reviewed change", expectedRevision: f.data.status!.revision });
    expect(f.data.diff?.patch).toBe("");
    await f.data.showDiff("sample.txt", false);
    await writeFile(join(f.path, "sample.txt"), "external edit\n");
    await f.data.loadGit();
    expect(f.data.diff?.patch).toContain("+external edit");
  });
  test("foreign workspace and host events cannot trigger this owner's reads", async () => {
    const f = await fixture(); f.data.start();
    for (const listener of f.listeners) { listener({ type: "workspace", sequence: 1, hostId: "remote", target: { projectId: "project" } }); listener({ type: "workspace", sequence: 2, hostId: "home", target: { projectId: "different" } }); }
    expect(f.owners).toHaveLength(0); await f.data.refresh(); expect(f.owners.every(owner => owner === "home")).toBe(true); f.data.stop();
  });
});

async function until(condition: () => boolean, timeout = 7_000) {
  const end = Date.now() + timeout;
  while (!condition()) { if (Date.now() > end) throw new Error("Workspace condition did not settle"); await Bun.sleep(20); }
}

describe("workspace autosave through native file writes", () => {
  test("UI edits debounce into one owner-scoped write; manual buffer edits stay manual", async () => {
    const { data, deliveries, path, owners } = await fixture();
    await data.open("sample.txt"); data.start();
    try {
      data.edit("sample.txt", "manual\n"); await Bun.sleep(3_150);
      expect(deliveries).toHaveLength(0);
      data.edit("sample.txt", "first UI edit\n", true); await Bun.sleep(200);
      expect(deliveries).toHaveLength(0);
      data.edit("sample.txt", "latest UI edit\n", true);
      await until(() => !data.documents.get("sample.txt")!.dirty);
      expect(await readFile(join(path, "sample.txt"), "utf8")).toBe("latest UI edit\n");
      expect(deliveries).toHaveLength(1); expect(owners.every(owner => owner === "home")).toBe(true);
    } finally { data.stop(); }
  }, 12_000);

  test("a second edit while saving drains after the first actual receipt", async () => {
    const { data, deliveries, path, delay } = await fixture();
    await data.open("sample.txt"); const entered = deferred(), release = deferred();
    delay(async () => { if (deliveries.length === 1) { entered.resolve(); await release.promise; } });
    data.start();
    try {
      data.edit("sample.txt", "submitted\n", true); await entered.promise;
      data.edit("sample.txt", "newer\n", true); release.resolve();
      await until(() => deliveries.length === 2 && !data.busy);
      expect(await readFile(join(path, "sample.txt"), "utf8")).toBe("newer\n");
      expect(deliveries[0]!.id).not.toBe(deliveries[1]!.id);
      expect(data.documents.get("sample.txt")!.dirty).toBe(false);
    } finally { release.resolve(); data.stop(); }
  }, 12_000);

  test("offline edits resume with CAS and never overwrite a changed host file", async () => {
    const { data, deliveries, path } = await fixture();
    await data.open("sample.txt"); data.start();
    try {
      data.setConnected(false); data.edit("sample.txt", "offline\n", true); await Bun.sleep(3_150);
      expect(deliveries).toHaveLength(0);
      await writeFile(join(path, "sample.txt"), "external\n"); data.setConnected(true);
      await until(() => data.documents.get("sample.txt")!.conflict !== undefined);
      expect(await readFile(join(path, "sample.txt"), "utf8")).toBe("external\n");
      expect(data.documents.get("sample.txt")!.text).toBe("offline\n");
      const count = deliveries.length; await Bun.sleep(3_150); expect(deliveries).toHaveLength(count);
      expect(await data.saveUntilClean("sample.txt")).toBe(false);
    } finally { data.stop(); }
  }, 12_000);

  test("unknown receipt pauses autosave and explicit recovery reuses the original command", async () => {
    const { data, deliveries, path, dropNextReceipt } = await fixture();
    await data.open("sample.txt"); data.start();
    try {
      dropNextReceipt(); data.edit("sample.txt", "saved with lost receipt\n", true);
      await until(() => Boolean(data.pending?.uncertain) && !data.busy);
      expect(await readFile(join(path, "sample.txt"), "utf8")).toBe("saved with lost receipt\n");
      const first = deliveries[0]!; await Bun.sleep(3_150); expect(deliveries).toHaveLength(1);
      expect(await data.saveUntilClean("sample.txt")).toBe(false);
      await data.retry(); expect(deliveries).toHaveLength(2); expect(deliveries[1]).toEqual(first);
      expect(data.pending).toBeUndefined(); expect(data.documents.get("sample.txt")!.dirty).toBe(false);
    } finally { data.stop(); }
  }, 12_000);

  test("close saves until clean, including edits during save; discard preserves an unresolved receipt", async () => {
    const { data, path, delay, deliveries, dropNextReceipt } = await fixture();
    await data.read("sample.txt"); const entered = deferred(), release = deferred();
    delay(async () => { if (deliveries.length === 1) { entered.resolve(); await release.promise; } });
    data.edit("sample.txt", "close first\n", true);
    const closing = data.saveUntilClean("sample.txt"); await entered.promise;
    data.edit("sample.txt", "close latest\n", true); release.resolve();
    expect(await closing).toBe(true); expect(deliveries).toHaveLength(2);
    expect(await readFile(join(path, "sample.txt"), "utf8")).toBe("close latest\n");
    dropNextReceipt(); data.edit("sample.txt", "uncertain\n", true); expect(await data.saveUntilClean("sample.txt")).toBe(false);
    const id = data.pending!.envelope.id; expect(await data.discardFileEdits("sample.txt")).toBe(true);
    expect(data.documents.get("sample.txt")!.dirty).toBe(false);
    expect(data.pending!.envelope.id).toBe(id);
    await data.retry(); expect(data.documents.get("sample.txt")!.dirty).toBe(false);
    expect(data.documents.get("sample.txt")!.text).toBe("uncertain\n");
    expect(data.documents.get("sample.txt")!.discardedSaveId).toBeUndefined();
  });
});

test("restored explicit autosave intent survives offline restart without adopting a legacy manual buffer", async () => {
  const { data, bridge, cache, path, deliveries } = await fixture();
  await data.open("sample.txt"); data.setConnected(false);
  data.edit("sample.txt", "restored autosave draft\n", true);
  await until(() => Boolean(cache.values.get(data.cacheKey)?.includes("restored autosave draft")));
  const resumed = new WorkspaceState(bridge, "home", { projectId: "project" }, cache, "home");
  await resumed.restore(); resumed.start();
  try {
    await Bun.sleep(200); expect(deliveries).toHaveLength(0);
    expect(resumed.documents.get("sample.txt")!.text).toBe("restored autosave draft\n");
    resumed.setConnected(true);
    await until(() => !resumed.documents.get("sample.txt")!.dirty);
    expect(await readFile(join(path, "sample.txt"), "utf8")).toBe("restored autosave draft\n");
    expect(deliveries).toHaveLength(1);
  } finally { resumed.stop(); }
}, 8_000);

test("failed durable discard keeps the buffer and cannot confirm tab closure", async () => {
  const { data, cache, deliveries } = await fixture(); await data.open("sample.txt");
  data.edit("sample.txt", "retain if discard storage fails\n");
  await until(() => Boolean(cache.values.get(data.cacheKey)?.includes("retain if discard storage fails")));
  cache.write = async () => { throw new Error("Recovery storage unavailable"); };
  expect(await data.discardFileEdits("sample.txt")).toBe(false);
  expect(data.documents.get("sample.txt")!.text).toBe("retain if discard storage fails\n");
  expect(data.documents.get("sample.txt")!.dirty).toBe(true); expect(deliveries).toHaveLength(0);
});

test("legacy version1 dirty cache without autosave intent never becomes an automatic write", async () => {
  const { data, bridge, cache, deliveries, path } = await fixture();
  await data.open("sample.txt"); data.edit("sample.txt", "legacy manual draft\n");
  await until(() => Boolean(cache.values.get(data.cacheKey)?.includes("legacy manual draft")));
  const cached = JSON.parse(cache.values.get(data.cacheKey)!);
  expect(cached.version).toBe(1); expect(cached.documents[0][1].autosave).toBeUndefined();
  const resumed = new WorkspaceState(bridge, "home", { projectId: "project" }, cache, "home");
  await resumed.restore(); resumed.setConnected(true); resumed.start();
  try {
    await Bun.sleep(3_150); expect(deliveries).toHaveLength(0);
    expect(resumed.documents.get("sample.txt")!.text).toBe("legacy manual draft\n");
    expect(await readFile(join(path, "sample.txt"), "utf8")).toBe("original\n");
  } finally { resumed.stop(); }
}, 8_000);

test("discard receipt marker survives restore and clean reads but never replaces a later edit", async () => {
  for (const [readAgain, editAgain] of [[false, false], [true, false], [true, true]]) {
    const { data, bridge, cache, dropNextReceipt, deliveries } = await fixture();
    await data.read("sample.txt"); data.edit("sample.txt", "accepted on host\n", true);
    dropNextReceipt(); await data.saveFile("sample.txt"); const id = data.pending!.envelope.id;
    expect(await data.discardFileEdits("sample.txt")).toBe(true);
    const resumed = new WorkspaceState(bridge, "home", { projectId: "project" }, cache, "home");
    await resumed.restore(); resumed.setConnected(true); if (readAgain) await resumed.read("sample.txt");
    expect(resumed.documents.get("sample.txt")!.discardedSaveId).toBe(id);
    if (editAgain) resumed.edit("sample.txt", "new explicit edit after discard\n");
    await resumed.retry();
    expect(deliveries).toHaveLength(2); expect(deliveries[1]!.id).toBe(id);
    expect(resumed.documents.get("sample.txt")!.dirty).toBe(editAgain);
    expect(resumed.documents.get("sample.txt")!.text).toBe(editAgain ? "new explicit edit after discard\n" : "accepted on host\n");
  }
});

test("normal window close drains an opted-in save and persists manual/offline buffers", async () => {
  const f = await fixture(); await f.data.open("sample.txt");
  f.data.edit("sample.txt", "close autosave\n", true);
  const held = deferred(); f.delay(() => held.promise);
  let done = false; const closing = f.data.prepareWindowClose().then(value => { done = true; return value; });
  for (let i = 0; !f.deliveries.length && i < 100; i++) await Bun.sleep(5);
  expect(f.deliveries).toHaveLength(1); expect(done).toBe(false);
  held.resolve(); expect(await closing).toBe(true);
  expect(await readFile(join(f.path, "sample.txt"), "utf8")).toBe("close autosave\n");
  f.data.setConnected(false); f.data.edit("sample.txt", "offline recovery\n", true);
  expect(await f.data.prepareWindowClose()).toBe(true); expect(f.deliveries).toHaveLength(1);
  const next = new WorkspaceState(f.bridge, "home", {projectId:"project"}, f.cache, "home"); await next.restore();
  expect(next.documents.get("sample.txt")?.text).toBe("offline recovery\n");
  expect(next.documents.get("sample.txt")?.dirty).toBe(true);
});

test("window close never replays an unconfirmed save and refuses recovery storage failure", async () => {
  const f = await fixture(); await f.data.open("sample.txt"); f.data.edit("sample.txt", "unconfirmed\n", true); f.dropNextReceipt();
  expect(await f.data.prepareWindowClose()).toBe(false); const id = f.deliveries[0]!.id;
  expect(await f.data.prepareWindowClose()).toBe(false); expect(f.deliveries).toHaveLength(1);
  expect(f.data.pending?.envelope.id).toBe(id);
  f.data.setConnected(false); f.cache.write = async () => { throw new Error("disk full"); };
  await expect(f.data.prepareWindowClose()).rejects.toThrow("disk full");
  expect(f.data.documents.get("sample.txt")?.text).toBe("unconfirmed\n");
});

test("close preserves online manual buffers and cancellation cannot drain a later edit", async () => {
  const f = await fixture(); await f.data.open("sample.txt"); f.data.edit("sample.txt", "manual recovery\n", false);
  expect(await f.data.prepareWindowClose()).toBe(true); expect(f.deliveries).toHaveLength(0);
  const restored = new WorkspaceState(f.bridge, "home", {projectId:"project"}, f.cache, "home"); await restored.restore();
  expect(restored.documents.get("sample.txt")?.text).toBe("manual recovery\n"); expect(restored.documents.get("sample.txt")?.dirty).toBe(true);
  f.data.edit("sample.txt", "save A\n", true); const held = deferred(); f.delay(() => held.promise);
  const abort = new AbortController(), closing = f.data.prepareWindowClose(abort.signal); const rejected = closing.catch(error => error);
  for (let i = 0; !f.deliveries.length && i < 100; i++) await Bun.sleep(5);
  abort.abort(new Error("keep open")); f.data.edit("sample.txt", "later B\n", true); held.resolve(); expect((await rejected).message).toBe("keep open");
  expect(f.deliveries).toHaveLength(1); expect(await readFile(join(f.path, "sample.txt"), "utf8")).toBe("save A\n");
  expect(f.data.documents.get("sample.txt")?.text).toBe("later B\n"); expect(f.data.documents.get("sample.txt")?.dirty).toBe(true);
});


describe("standalone file editor ownership", () => {
  test("refresh reads only the file and offline recovery preserves edits across host conflicts", async () => {
    const f = await fixture(true);
    const queries: string[] = [];
    const original = f.bridge.workspaceQuery;
    f.bridge.workspaceQuery = async (target, query, hostId) => {
      expect(target).toEqual({filePath: join(f.path, "sample.txt")});
      queries.push(query.type);
      return original(target, query, hostId);
    };
    await f.data.refresh();
    expect(queries).toEqual(["file.read"]);
    expect(f.data.directories.size).toBe(0);
    expect(f.data.status).toBeUndefined();
    f.data.edit("sample.txt", "standalone draft\n");
    await new Promise(resolve => setTimeout(resolve, 0));
    const resumed = new WorkspaceState(f.bridge, "home", {filePath:join(f.path,"sample.txt")}, f.cache, "home");
    await resumed.restore();
    expect(resumed.documents.get("sample.txt")?.text).toBe("standalone draft\n");
    expect(resumed.documents.get("sample.txt")?.dirty).toBe(true);
    await writeFile(join(f.path,"sample.txt"), "changed on host\n");
    resumed.setConnected(true); await resumed.refresh();
    expect(resumed.documents.get("sample.txt")?.text).toBe("standalone draft\n");
    expect(resumed.documents.get("sample.txt")?.conflict?.kind).toBe("text");
    expect(f.deliveries).toHaveLength(0);
    resumed.resolve("sample.txt", "local"); await resumed.saveFile("sample.txt");
    expect(await readFile(join(f.path,"sample.txt"),"utf8")).toBe("standalone draft\n");
    expect(f.deliveries).toHaveLength(1);
    expect(f.deliveries[0]!.command).toMatchObject({type:"workspace.mutate",target:{filePath:join(f.path,"sample.txt")},action:{type:"file.write",path:"sample.txt"}});
    expect(queries.every(type => type === "file.read")).toBe(true);
  });

  test("restored standalone state cannot replay a different owner or broader action", async () => {
    const f = await fixture(true);
    for (const command of [
      {type:"workspace.mutate", target:{filePath:join(f.path,"other.txt")}, action:{type:"file.write",path:"other.txt",text:"wrong",expectedRevision:null}},
      {type:"workspace.mutate", target:f.data.target, action:{type:"git.stage",paths:["sample.txt"]}},
      {type:"workspace.mutate", target:f.data.target, action:{type:"file.write",path:"other.txt",text:"wrong",expectedRevision:null}},
    ]) {
      await f.cache.write(f.data.cacheKey,JSON.stringify({version:1,documents:[],pending:{envelope:{id:crypto.randomUUID(),command},uncertain:true}}));
      const resumed = new WorkspaceState(f.bridge,"home",f.data.target,f.cache,"home");
      await resumed.restore(); resumed.setConnected(true); await resumed.retry();
      expect(resumed.restored).toBe(false); expect(resumed.cacheWarning).toContain("Mutations are paused");
      expect(resumed.pending).toBeUndefined(); expect(f.deliveries).toHaveLength(0);
    }
    await f.cache.write(f.data.cacheKey,JSON.stringify({version:1,documents:[["other.txt",{text:"foreign",dirty:true}]]}));
    const resumed = new WorkspaceState(f.bridge,"home",f.data.target,f.cache,"home");
    await resumed.restore(); expect(resumed.restored).toBe(false); expect(resumed.documents.size).toBe(0);
  });

  test("Markdown image leases use their own exact host file target", async () => {
    const f = await fixture(true), acquired: unknown[] = [], released: string[] = [];
    const bridge = {...f.bridge, acquireWorkspaceImage: async (target: unknown,path: string,hostId?:string) => {
      acquired.push({target,path,hostId}); return {id:"image-lease",url:"agent-workspace-image://image-lease"};
    }, releaseWorkspaceImage: async (id:string) => {released.push(id);}};
    const data = new WorkspaceState(bridge,"home",f.data.target,f.cache,"home"); data.setConnected(true);
    const lease = await data.acquireImage("images/chart.png");
    expect(acquired).toEqual([{target:{filePath:join(f.path,"images/chart.png")},path:"chart.png",hostId:"home"}]);
    await lease.release(); expect(released).toEqual(["image-lease"]);
    await expect(data.acquireImage("../escape.png")).rejects.toThrow("canonical absolute");
    expect(acquired).toHaveLength(1);
    const outside = await data.acquireImage("/other/assets/chart.png");
    expect(acquired[1]).toEqual({target:{filePath:"/other/assets/chart.png"},path:"chart.png",hostId:"home"});
    await outside.release();
  });
});


test("owning workspace forwards revision resolution without a mutation envelope", async () => {
  const f = await fixture();
  try {
    const revision = await f.data.query({ type: "git.resolve-revision", expression: "HEAD" });
    expect(revision).toEqual({ type: "git.resolve-revision", revision: { expression: "HEAD", commit: f.git("rev-parse", "HEAD") } });
    expect(f.owners.at(-1)).toBe("home");
    expect(f.deliveries).toHaveLength(0);
  } finally { f.data.stop(); }
});


test("revision checkout receipt retries the original envelope without a second native switch", async () => {
  const f = await fixture(); await f.data.loadGit();
  const revision = { expression: "HEAD", commit: f.git("rev-parse", "HEAD") };
  await f.data.open("sample.txt"); f.data.edit("sample.txt", "unsent revision buffer\n");
  f.dropNextReceipt();
  await f.data.mutate({ type: "git.checkout-revision", revision, expectedRevision: f.data.status!.revision });
  expect(f.data.pending?.uncertain).toBe(true);
  const original = f.deliveries[0]!;
  expect(original.command).toMatchObject({ action: { type: "git.checkout-revision", revision } });
  const next = new WorkspaceState(f.bridge, "home", { projectId: "project" }, f.cache, "home");
  try {
    await next.restore(); next.setConnected(true); await next.retry();
    expect(f.deliveries).toEqual([original, original]);
    expect(next.pending).toBeUndefined(); expect(next.status).toMatchObject({ branch: null, head: revision.commit });
    expect(next.notice).toBe("Switched to detached HEAD.");
    expect(next.documents.get("sample.txt")).toMatchObject({ text: "unsent revision buffer\n", dirty: true });
    expect(f.git("reflog", "--format=%gs").split("\n").filter(line => line.startsWith("checkout:"))).toHaveLength(1);
  } finally { f.data.stop(); next.stop(); }
});


test("owning workspace forwards recent branches without a mutation envelope", async () => {
  const f = await fixture();
  try {
    const branches = await f.data.query({ type: "git.recent-branches", limit: 1 });
    expect(branches).toEqual({ type: "git.recent-branches", branches: ["main"] });
    expect(f.owners.at(-1)).toBe("home");
    expect(f.deliveries).toHaveLength(0);
  } finally { f.data.stop(); }
});


test("owning workspace forwards default branch discovery without a mutation envelope", async () => {
  const f = await fixture();
  try {
    expect(await f.data.query({ type: "git.default-branch" })).toEqual({ type: "git.default-branch", branch: "main" });
    expect(f.owners.at(-1)).toBe("home"); expect(f.deliveries).toHaveLength(0);
  } finally { f.data.stop(); }
});


test("owning workspace forwards base branch discovery without a mutation envelope", async () => {
  const f = await fixture();
  try {
    expect(await f.data.query({ type: "git.base-branch" })).toEqual({ type: "git.base-branch", base: null });
    expect(f.owners.at(-1)).toBe("home"); expect(f.deliveries).toHaveLength(0);
  } finally { f.data.stop(); }
});


test("owning workspace forwards checkout target resolution without a mutation envelope", async () => {
  const f = await fixture();
  try {
    expect(await f.data.query({ type: "git.resolve-checkout", expression: "main" })).toEqual({ type: "git.resolve-checkout", target: {
      kind: "branch", expression: "main", selection: { ref: "refs/heads/main", commit: f.git("rev-parse", "HEAD") },
    } });
    expect(f.owners.at(-1)).toBe("home"); expect(f.deliveries).toHaveLength(0);
  } finally { f.data.stop(); }
});
