import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitSubmissionIntent, GitSubmissionTarget } from "@agent-desktop/shared";
import { HostStore } from "./store";
import { HostWorkspaces, parseGitSubmissionIntent } from "./workspace-http";
import type { GitSubmissionDependencies } from "./workspace-submissions";

const roots: string[] = [], stores = new Set<HostStore>(), owners: HostWorkspaces[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.shutdownSubmissions()));
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture(generate?: GitSubmissionDependencies["generate"]) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "compound-git-"))); roots.push(root);
  const cwd = join(root, "repo"), remote = join(root, "remote.git"), data = join(root, "data"), hooks = join(root, "hooks");
  await mkdir(cwd); await mkdir(hooks);
  git(cwd, "init", "-q", "--initial-branch=main");
  git(cwd, "config", "user.name", "Compound Fixture"); git(cwd, "config", "user.email", "fixture@example.invalid");
  git(cwd, "config", "commit.gpgSign", "false"); git(cwd, "config", "core.hooksPath", hooks);
  await writeFile(join(cwd, "README.md"), "base\n"); git(cwd, "add", "README.md"); git(cwd, "commit", "-qm", "fixture");
  git(root, "init", "-q", "--bare", remote); git(cwd, "remote", "add", "origin", remote);
  await writeFile(join(cwd, "README.md"), "base\nselected\n"); git(cwd, "add", "README.md");
  const store = new HostStore(data); stores.add(store);
  const project = store.addProject({ path: cwd }); const target = { projectId: project.id };
  let events = 0, eventAction = () => {};
  const workspace = new HostWorkspaces(store, data, () => () => {}, undefined, undefined, undefined, {
    generate: generate ?? (() => { throw new Error("Typed messages must not invoke a provider"); }), changed: () => { events++; eventAction(); },
  }); owners.push(workspace);
  async function intent(operation: GitSubmissionIntent["operation"] = "commit-and-push", forTarget: GitSubmissionTarget = target) {
    const result = await workspace.query(forTarget, { type: "git.action-context" });
    if (result.type !== "git.action-context" || result.context.push.state !== "available") throw new Error("Fixture destination unavailable");
    return { operation, contextRevision: result.context.revision, selectionMode: "staged" as const, message: "Selected change", destination: result.context.push.destination };
  }
  function submit(id: string, selection: GitSubmissionIntent, forTarget: GitSubmissionTarget = target) {
    const action = { type: "git.submit" as const, intent: selection };
    store.claimCommand(id, `hash-${id}`, { type: "workspace.mutate", target: forTarget, action });
    return workspace.mutate(forTarget, action, id).then(result => {
      if (result.type !== "git.submit") throw new Error("Unexpected result"); return result.receipt;
    });
  }
  return { root, cwd, remote, data, hooks, store, workspace, target, intent, submit, events: () => events, onEvent: (action: () => void) => { eventAction = action; } };
}

test("one original host command commits and pushes, persists its partials, and cannot replay after restart", async () => {
  const f = await fixture(), selection = await f.intent(), before = git(f.cwd, "rev-parse", "HEAD");
  const receipt = await f.submit("original", selection);
  expect(receipt).toMatchObject({ outcome: "succeeded", phase: "completed", push: { applied: { remote: "confirmed", upstream: "configured" } } });
  expect(receipt.commit?.commit).not.toBe(before);
  expect(git(f.remote, "rev-parse", "refs/heads/main")).toBe(receipt.commit!.commit);
  expect(git(f.cwd, "rev-list", "--count", "HEAD")).toBe("2");
  expect(f.events()).toBeGreaterThan(3);
  expect(await f.submit("original", selection)).toEqual(receipt);
  f.store.close(); stores.delete(f.store);
  const reopened = new HostStore(f.data); stores.add(reopened);
  const workspace = new HostWorkspaces(reopened, f.data, () => { throw new Error("Replay reserved Git"); }); owners.push(workspace);
  expect(await workspace.query(f.target, { type: "git.submission", commandId: "original" })).toEqual({ type: "git.submission", receipt });
  const replay = await workspace.mutate(f.target, { type: "git.submit", intent: selection }, "original");
  expect(replay).toEqual({ type: "git.submit", receipt });
  expect(git(f.cwd, "rev-list", "--count", "HEAD")).toBe("2");
});

test("remote rejection retains the successful commit without resending or regenerating", async () => {
  const f = await fixture();
  await writeFile(join(f.remote, "hooks/pre-receive"), "#!/bin/sh\nexit 1\n"); await chmod(join(f.remote, "hooks/pre-receive"), 0o755);
  const selection = await f.intent(), receipt = await f.submit("rejected", selection);
  expect(receipt).toMatchObject({ outcome: "failed", error: { code: "PUSH_REJECTED" }, push: { applied: { remote: "rejected" } } });
  expect(receipt.commit?.commit).toBe(git(f.cwd, "rev-parse", "HEAD"));
  expect(git(f.cwd, "rev-list", "--count", "HEAD")).toBe("2");
  expect(await f.submit("rejected", selection)).toEqual(receipt);
  expect(git(f.cwd, "rev-list", "--count", "HEAD")).toBe("2");
});

test("a native rejecting commit hook is definite failure with unchanged HEAD and no push", async () => {
  const f = await fixture();
  await writeFile(join(f.hooks, "pre-commit"), "#!/bin/sh\nexit 1\n"); await chmod(join(f.hooks, "pre-commit"), 0o755);
  const before = git(f.cwd, "rev-parse", "HEAD"), receipt = await f.submit("hook", await f.intent());
  expect(receipt.outcome).toBe("failed"); expect(receipt.error?.code).toBe("GIT_FAILED");
  expect(receipt.commit).toBeUndefined(); expect(receipt.push).toBeUndefined();
  expect(git(f.cwd, "rev-parse", "HEAD")).toBe(before);
  expect(git(f.cwd, "diff", "--cached", "--name-only")).toBe("README.md");
});

test("generation cancellation resolves the original receipt once without a Git mutation", async () => {
  const entered = deferred<void>(); let calls = 0;
  const f = await fixture(async (_input, options) => {
    calls++; entered.resolve();
    await new Promise<never>((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("fixture cancelled")), { once: true }));
    throw new Error("unreachable");
  });
  const before = git(f.cwd, "rev-parse", "HEAD"), selection = { ...await f.intent(), message: "" };
  const original = f.submit("cancelled", selection); await entered.promise;
  const cancelled = await f.workspace.mutate(f.target, { type: "git.submit.cancel", commandId: "cancelled" });
  expect(cancelled.type).toBe("git.submit.cancel");
  const receipt = await original;
  expect(receipt).toMatchObject({ outcome: "cancelled", cancelRequested: true });
  expect(await f.submit("cancelled", selection)).toEqual(receipt); expect(calls).toBe(1);
  expect(git(f.cwd, "rev-parse", "HEAD")).toBe(before);
});

test("owner movement during generation prevents committing to the old session directory", async () => {
  const entered = deferred<void>(), release = deferred<void>();
  const f = await fixture(async () => { entered.resolve(); await release.promise; return { message: "Fixture generated message", stagedAll: false } as Awaited<ReturnType<GitSubmissionDependencies["generate"]>>; });
  const session = { id: "owned-session", hostId: f.store.host.id, projectId: f.target.projectId, cwd: f.cwd, title: "Fixture", status: "idle" as const,
    sessionFile: join(f.root, "unused.jsonl"), model: null, createdAt: 1, updatedAt: 1, archived: false };
  f.store.upsertSession(session); const target = { sessionId: session.id };
  const selection = { ...await f.intent("commit", target), message: "" }, before = git(f.cwd, "rev-parse", "HEAD");
  const original = f.submit("moved", selection, target); await entered.promise;
  f.store.upsertSession({ ...session, sessionFile: join(f.root, "different.jsonl") }); release.resolve();
  const receipt = await original;
  expect(receipt).toMatchObject({ outcome: "failed", error: { code: "WORKSPACE_CHANGED" } });
  expect(receipt.commit).toBeUndefined(); expect(git(f.cwd, "rev-parse", "HEAD")).toBe(before);
  expect(await f.workspace.query(f.target, { type: "git.submission", commandId: "moved" })).toEqual({ type: "git.submission", receipt: null });
});

test("Git intent discriminants reject JSON arrays that stringify to valid choices", () => {
  const valid = { operation: "commit" as const, selectionMode: "staged" as const, contextRevision: "a".repeat(64), message: "test" };
  expect(parseGitSubmissionIntent(valid)).toEqual(valid);
  expect(() => parseGitSubmissionIntent({ ...valid, operation: ["commit"] })).toThrow();
  expect(() => parseGitSubmissionIntent({ ...valid, selectionMode: ["staged"] })).toThrow();
});

test("push-only publishes the reviewed HEAD without committing or consuming staged changes", async () => {
  const f = await fixture(), before = git(f.cwd, "rev-parse", "HEAD"), index = await Bun.file(join(f.cwd, ".git/index")).arrayBuffer();
  const receipt = await f.submit("push-only", await f.intent("push"));
  expect(receipt).toMatchObject({ outcome: "succeeded", operation: "push", push: { sourceCommit: before } });
  expect(receipt.commit).toBeUndefined(); expect(git(f.remote, "rev-parse", "refs/heads/main")).toBe(before);
  expect(await Bun.file(join(f.cwd, ".git/index")).arrayBuffer()).toEqual(index);
});

test("include-unstaged on a new branch commits the captured changes through one submission", async () => {
  const f = await fixture(), before = git(f.cwd, "rev-parse", "HEAD");
  await writeFile(join(f.cwd, "README.md"), "base\nselected\nworking\n");
  const selection = { ...await f.intent("commit"), selectionMode: "include-unstaged" as const, branch: { name: "codex/compound", create: true } };
  const receipt = await f.submit("branch-commit", selection);
  expect(receipt).toMatchObject({ outcome: "succeeded", branch: { before: "main", after: "codex/compound", head: before } });
  expect(git(f.cwd, "show", "HEAD:README.md")).toBe("base\nselected\nworking");
  expect(git(f.cwd, "rev-parse", "main")).toBe(before); expect(git(f.cwd, "status", "--porcelain")).toBe("");
});

test("post-commit push configuration change preserves commit and stops before remote dispatch", async () => {
  const f = await fixture();
  await writeFile(join(f.hooks, "post-commit"), "#!/bin/sh\ngit config push.default nothing\n"); await chmod(join(f.hooks, "post-commit"), 0o755);
  const receipt = await f.submit("config-changed", await f.intent());
  expect(receipt).toMatchObject({ outcome: "failed", error: { code: "GIT_CHANGED" } });
  expect(receipt.commit?.commit).toBe(git(f.cwd, "rev-parse", "HEAD")); expect(receipt.push).toBeUndefined();
  expect(git(f.remote, "for-each-ref", "--format=%(refname)")).toBe("");
});

test("owner binding is checked at commit dispatch after the phase notification", async () => {
  const f = await fixture();
  const session = { id: "dispatch-owner", hostId: f.store.host.id, projectId: f.target.projectId, cwd: f.cwd, title: "Fixture", status: "idle" as const,
    sessionFile: join(f.root, "original.jsonl"), model: null, createdAt: 1, updatedAt: 1, archived: false };
  f.store.upsertSession(session); const target = { sessionId: session.id };
  const selection = await f.intent("commit", target), before = git(f.cwd, "rev-parse", "HEAD");
  let moved = false;
  f.onEvent(() => {
    if (!moved && f.store.getGitSubmission(target, "dispatch-move")?.phase === "committing") {
      moved = true; f.store.upsertSession({ ...session, sessionFile: join(f.root, "replacement.jsonl") });
    }
  });
  const receipt = await f.submit("dispatch-move", selection, target);
  expect(moved).toBe(true);
  expect(receipt).toMatchObject({ outcome: "failed", error: { code: "WORKSPACE_CHANGED" } });
  expect(git(f.cwd, "rev-parse", "HEAD")).toBe(before);
});

test("new branch commit-and-push uses its explicitly selected new ref", async () => {
  const f = await fixture(), selection = await f.intent(), before = git(f.cwd, "rev-parse", "HEAD");
  const receipt = await f.submit("new-ref", { ...selection, branch: { name: "codex/new-ref", create: true },
    destination: { ...selection.destination, targetRef: "refs/heads/codex/new-ref", requiresUpstreamSetup: true } });
  expect(receipt).toMatchObject({ outcome: "succeeded", branch: { after: "codex/new-ref" }, push: { targetRef: "refs/heads/codex/new-ref", applied: { upstream: "configured" } } });
  expect(git(f.remote, "rev-parse", "refs/heads/codex/new-ref")).toBe(receipt.commit!.commit);
  expect(git(f.remote, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/codex/new-ref");
  expect(git(f.cwd, "rev-parse", "main")).toBe(before);
});

test("a queued receipt reaching a stopped controller finishes instead of remaining permanently pending", async () => {
  const f = await fixture(), selection = await f.intent("commit");
  f.store.claimCommand("queued", "hash-queued", { type: "workspace.mutate", target: f.target, action: { type: "git.submit", intent: selection } });
  f.store.beginGitSubmission("queued", "hash-queued");
  await f.workspace.shutdownSubmissions();
  const receipt = await f.submit("queued", selection);
  expect(receipt).toMatchObject({ outcome: "failed", phase: "completed", error: { code: "HOST_STOPPING" }, cancelRequested: false });
  expect(f.store.getCommand("queued")?.state).toBe("done"); expect(git(f.cwd, "rev-list", "--count", "HEAD")).toBe("1");
});

test("host stop after verified commit preserves it without labeling the stop as user cancellation", async () => {
  const f = await fixture(); let stop: Promise<void> | undefined;
  f.onEvent(() => {
    if (!stop && f.store.getGitSubmission(f.target, "stop-after-commit")?.commit) stop = f.workspace.shutdownSubmissions();
  });
  const receipt = await f.submit("stop-after-commit", await f.intent()); await stop;
  expect(receipt).toMatchObject({ outcome: "failed", cancelRequested: false, error: { code: "HOST_STOPPING" } });
  expect(receipt.commit?.commit).toBe(git(f.cwd, "rev-parse", "HEAD")); expect(receipt.push).toBeUndefined();
  expect(git(f.remote, "for-each-ref", "--format=%(refname)")).toBe("");
});

test("a known existing-branch creation failure is definite and makes no commit", async () => {
  const f = await fixture(); git(f.cwd, "branch", "already-here");
  const receipt = await f.submit("existing", { ...await f.intent("commit"), branch: { name: "already-here", create: true } });
  expect(receipt).toMatchObject({ outcome: "failed", error: { code: "BRANCH_EXISTS" } });
  expect(receipt.branch).toBeUndefined(); expect(receipt.commit).toBeUndefined(); expect(git(f.cwd, "branch", "--show-current")).toBe("main");
});
