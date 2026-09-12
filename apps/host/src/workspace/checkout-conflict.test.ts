import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService } from "./service";
import { readCheckoutConflict } from "./checkout-conflict";

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

test("checkout conflict grammar retains Git display paths and stops at advice", () => {
  expect(readCheckoutConflict('error: Your local changes would be overwritten by checkout:\r\n\ttracked\r\n\t"quoted\\tpath"\n\ttracked\n\nPlease commit your changes\nignored'))
    .toEqual({ conflictedPaths: ["tracked", '"quoted\\tpath"'] });
  expect(readCheckoutConflict("Your untracked files would be overwritten by checkout:\nAborting")).toEqual({ conflictedPaths: [] });
  expect(readCheckoutConflict("fatal: unknown branch\ntracked")).toBeUndefined();
  expect(readCheckoutConflict("would be overwritten by merge:\ntracked")).toBeUndefined();
  expect(readCheckoutConflict("would be overwritten by checkout:\nfile\nerror: second error\nnot a path"))
    .toEqual({ conflictedPaths: ["file"] });
});

test("actual tracked refusal is classified for local, remote and detached checkout without losing source bytes", async () => {
  const f = await fixture(); await writeFile(join(f.cwd, "tracked"), "unsaved work\n");
  const before = await f.snapshot(), status = await f.service.gitStatus();
  const attempts = [() => f.service.checkout("topic", status.revision),
    () => f.service.checkoutRef({ ref: "refs/heads/topic", commit: f.target }, status.revision),
    () => f.service.checkoutRef({ ref: "refs/remotes/origin/remote-topic", localBranch: "remote-topic", commit: f.target }, status.revision),
    () => f.service.checkoutRevision({ expression: "topic", commit: f.target }, status.revision)];
  for (const attempt of attempts) {
    await expect(attempt()).rejects.toMatchObject({ code: "GIT_CHECKOUT_BLOCKED", conflictedPaths: ["tracked"] });
    expect(await f.snapshot()).toEqual(before);
  }
});

test("actual untracked refusal retains the collision path and original bytes", async () => {
  const f = await fixture(); await writeFile(join(f.cwd, "incoming"), "local untracked\n"); const before = await f.snapshot();
  await expect(f.service.checkout("topic", (await f.service.gitStatus()).revision)).rejects.toMatchObject({ code: "GIT_CHECKOUT_BLOCKED", conflictedPaths: ["incoming"] });
  expect(await f.snapshot()).toEqual(before);
});

test("checkout failure after leaving a new local branch behind remains unknown", async () => {
  const f = await fixture(), head = git(f.cwd, "rev-parse", "HEAD");
  // The native post-checkout hook restores HEAD but leaves the created ref.
  const hook = join(f.hooks, "post-checkout");
  await writeFile(hook, '#!/bin/sh\ngit symbolic-ref HEAD refs/heads/main\nprintf "error: local changes would be overwritten by checkout:\\n\\ttracked\\nAborting\\n" >&2\nexit 1\n'); await chmod(hook, 0o755);
  await expect(f.service.checkout("created", (await f.service.gitStatus()).revision, true)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(git(f.cwd, "rev-parse", "refs/heads/created")).toBe(head);
  expect(git(f.cwd, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
});

test("operational failures and changed-state observations are never checkout refusals", async () => {
  const f = await fixture(), original = (f.service as any).git.bind(f.service);
  for (const code of ["GIT_TIMEOUT", "GIT_OUTPUT_TOO_LARGE", "GIT_FAILED"]) {
    (f.service as any).git = (args: string[], options: any) => {
      if (args.includes("switch")) return Promise.reject(Object.assign(new Error("would be overwritten by checkout:\ntracked"), { code }));
      return original(args, options);
    };
    await expect(f.service.checkout("topic", (await f.service.gitStatus()).revision)).rejects.toMatchObject({ code });
  }
  (f.service as any).git = async (args: string[], options: any) => {
    if (args.includes("switch")) { await writeFile(join(f.cwd, "tracked"), "external staged change\n"); git(f.cwd, "add", "tracked"); throw new Error("would be overwritten by checkout:\ntracked"); }
    return original(args, options);
  };
  await expect(f.service.checkout("topic", (await f.service.gitStatus()).revision)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
});
