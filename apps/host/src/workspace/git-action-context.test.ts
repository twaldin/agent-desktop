import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGitActionContext } from "./git-action-context";
import { WorkspaceService } from "./service";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "--no-optional-locks", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

async function repository(commit = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "agent-desktop-git-action-context-"))); roots.push(root);
  const cwd = join(root, "project"), hooks = join(root, "hooks");
  await mkdir(cwd); await mkdir(hooks);
  git(cwd, "init", "-q", "--initial-branch=main");
  git(cwd, "config", "user.name", "Git Context Fixture");
  git(cwd, "config", "user.email", "git-context@example.invalid");
  git(cwd, "config", "commit.gpgSign", "false");
  git(cwd, "config", "core.hooksPath", hooks);
  await writeFile(join(cwd, "tracked.txt"), "initial\n");
  if (commit) { git(cwd, "add", "tracked.txt"); git(cwd, "commit", "-qm", "initial"); }
  return { root, cwd, service: new WorkspaceService(cwd) };
}

function createBare(root: string, name: string) {
  const path = join(root, `${name}.git`);
  git(root, "init", "-q", "--bare", path);
  return path;
}

test("a sole non-origin remote is an explicit first-push destination without contacting it", async () => {
  const fixture = await repository();
  const remote = createBare(fixture.root, "sole");
  git(fixture.cwd, "remote", "add", "sole", remote);
  const context = await readGitActionContext(fixture.service);
  expect(context.push).toMatchObject({ state: "available", destination: {
    remote: "sole", targetRef: "refs/heads/main", requiresUpstreamSetup: true,
    localTrackingRef: null, commitsAhead: null, commitsBehind: null,
  }, alternatives: [], freshness: "local-config-and-refs" });
  expect(git(remote, "for-each-ref")).toBe("");
});

test("an existing upstream reports counts only against its local cached tracking ref", async () => {
  const fixture = await repository();
  const remote = createBare(fixture.root, "origin");
  git(fixture.cwd, "remote", "add", "origin", remote);
  git(fixture.cwd, "push", "-q", "--set-upstream", "origin", "main");
  await writeFile(join(fixture.cwd, "ahead.txt"), "ahead\n");
  git(fixture.cwd, "add", "ahead.txt"); git(fixture.cwd, "commit", "-qm", "ahead");
  const context = await readGitActionContext(fixture.service);
  expect(context.push).toMatchObject({ state: "available", destination: {
    remote: "origin", targetRef: "refs/heads/main", requiresUpstreamSetup: false,
    localTrackingRef: "refs/remotes/origin/main", commitsAhead: 1, commitsBehind: 0,
  }});
  expect(context.status).toMatchObject({ upstream: "origin/main", ahead: 1, behind: 0 });
});

test("a custom fetch refspec identifies the actual local cached destination ref", async () => {
  const fixture = await repository();
  const remote = createBare(fixture.root, "origin");
  git(fixture.cwd, "remote", "add", "origin", remote);
  git(fixture.cwd, "push", "-q", "origin", "main");
  git(fixture.cwd, "config", "--unset-all", "remote.origin.fetch");
  git(fixture.cwd, "config", "--add", "remote.origin.fetch", "+refs/heads/*:refs/cache/origin/*");
  git(fixture.cwd, "fetch", "-q", "origin");
  git(fixture.cwd, "config", "branch.main.remote", "origin");
  git(fixture.cwd, "config", "branch.main.merge", "refs/heads/main");
  const context = await readGitActionContext(fixture.service);
  expect(context.push).toMatchObject({ state: "available", destination: {
    remote: "origin", targetRef: "refs/heads/main", localTrackingRef: "refs/cache/origin/main",
    commitsAhead: 0, commitsBehind: 0,
  }});
});

test("multiple remotes without a configured default are ambiguous but remain selectable alternatives", async () => {
  const fixture = await repository();
  git(fixture.cwd, "remote", "add", "alpha", createBare(fixture.root, "alpha"));
  git(fixture.cwd, "remote", "add", "beta", createBare(fixture.root, "beta"));
  const context = await readGitActionContext(fixture.service);
  expect(context.push.state).toBe("unavailable");
  if (context.push.state !== "unavailable") throw new Error("Expected unavailable push context");
  expect(context.push.reason).toBe("ambiguous-remote");
  expect(context.push.alternatives.map(value => value.remote)).toEqual(["alpha", "beta"]);
  expect(context.push.alternatives.every(value => value.targetRef === "refs/heads/main" && value.requiresUpstreamSetup)).toBe(true);
});

test("simple mode sends the current branch name when pushRemote differs from the fetch upstream", async () => {
  const fixture = await repository();
  git(fixture.cwd, "remote", "add", "origin", createBare(fixture.root, "origin"));
  git(fixture.cwd, "remote", "add", "publish", createBare(fixture.root, "publish"));
  git(fixture.cwd, "config", "branch.main.remote", "origin");
  git(fixture.cwd, "config", "branch.main.merge", "refs/heads/different-name");
  git(fixture.cwd, "config", "branch.main.pushRemote", "publish");
  const context = await readGitActionContext(fixture.service);
  expect(context.push).toMatchObject({ state: "available", destination: {
    remote: "publish", targetRef: "refs/heads/main", requiresUpstreamSetup: false,
  }});
});

test("unborn, detached, missing, and non-single-target push modes have explicit reasons", async () => {
  const unborn = await repository(false);
  expect((await readGitActionContext(unborn.service)).push).toMatchObject({ state: "unavailable", reason: "unborn-head" });

  const missing = await repository();
  expect((await readGitActionContext(missing.service)).push).toMatchObject({ state: "unavailable", reason: "missing-remote" });

  const detached = await repository();
  git(detached.cwd, "checkout", "-q", "--detach");
  expect((await readGitActionContext(detached.service)).push).toMatchObject({ state: "unavailable", reason: "detached-head" });

  const matching = await repository();
  git(matching.cwd, "remote", "add", "origin", createBare(matching.root, "matching-origin"));
  git(matching.cwd, "config", "push.default", "matching");
  expect((await readGitActionContext(matching.service)).push).toMatchObject({ state: "unavailable", reason: "push-target-unresolved" });
});

test("destination revisions include effective push URL configuration without exposing URLs", async () => {
  const fixture = await repository();
  const first = createBare(fixture.root, "first"), second = createBare(fixture.root, "second");
  git(fixture.cwd, "remote", "add", "origin", first);
  const before = await readGitActionContext(fixture.service);
  git(fixture.cwd, "config", "--add", "remote.origin.pushurl", first);
  git(fixture.cwd, "config", "--add", "remote.origin.pushurl", second);
  const after = await readGitActionContext(fixture.service);
  if (before.push.state !== "available" || after.push.state !== "available") throw new Error("Expected available push contexts");
  expect(after.push.destination.revision).not.toBe(before.push.destination.revision);
  expect(JSON.stringify(after)).not.toContain(fixture.root);
});

test("a remote push-URL CLI failure is propagated instead of represented as an absent destination", async () => {
  const fixture = await repository();
  const remote = createBare(fixture.root, "origin");
  git(fixture.cwd, "remote", "add", "origin", remote);
  const bin = join(fixture.root, "bin"), home = join(fixture.root, "child-home"), agent = join(fixture.root, "child-agent"), marker = join(fixture.root, "push-url-invoked");
  await mkdir(bin); await mkdir(home); await mkdir(agent);
  await writeFile(join(bin, "git"), "#!/bin/sh\ncase \"$*\" in\n  *\"$GIT_ACTION_CONTEXT_FAILURE_PATTERN\"*) : > \"$GIT_ACTION_CONTEXT_FAILURE_MARKER\"; exit 77 ;;\nesac\nexec /usr/bin/git \"$@\"\n");
  await chmod(join(bin, "git"), 0o755);
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures", "git-action-context-failure.ts")], {
    cwd: fixture.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: bin, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PI_CODING_AGENT_DIR: agent,
      GIT_ACTION_CONTEXT_FIXTURE_CWD: fixture.cwd, GIT_ACTION_CONTEXT_FAILURE_MARKER: marker, GIT_ACTION_CONTEXT_FAILURE_PATTERN: "remote get-url --push --all" },
  });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const bounded = new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Context fixture timed out.")), 5_000); });
    expect(await Promise.race([child.exited, bounded])).toBe(0);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled([child.exited, stdout, stderr]);
  }
  expect(await stderr).toBe("");
  expect(await stat(marker).then(() => true, () => false)).toBe(true);
  const outcome = JSON.parse(await stdout);
  expect(outcome).toEqual({ ok: false, name: "WorkspaceError", code: "GIT_FAILED" });
});

test("an upstream CLI failure is propagated instead of represented as an absent upstream", async () => {
  const fixture = await repository();
  const remote = createBare(fixture.root, "origin");
  git(fixture.cwd, "remote", "add", "origin", remote);
  git(fixture.cwd, "push", "-q", "--set-upstream", "origin", "main");
  const bin = join(fixture.root, "bin"), home = join(fixture.root, "child-home"), agent = join(fixture.root, "child-agent"), marker = join(fixture.root, "upstream-invoked");
  await mkdir(bin); await mkdir(home); await mkdir(agent);
  await writeFile(join(bin, "git"), "#!/bin/sh\ncase \"$*\" in\n  *\"$GIT_ACTION_CONTEXT_FAILURE_PATTERN\"*) : > \"$GIT_ACTION_CONTEXT_FAILURE_MARKER\"; exit 77 ;;\nesac\nexec /usr/bin/git \"$@\"\n");
  await chmod(join(bin, "git"), 0o755);
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures", "git-action-context-failure.ts")], {
    cwd: fixture.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: bin, HOME: home, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", PI_CODING_AGENT_DIR: agent,
      GIT_ACTION_CONTEXT_FIXTURE_CWD: fixture.cwd, GIT_ACTION_CONTEXT_FAILURE_MARKER: marker, GIT_ACTION_CONTEXT_FAILURE_PATTERN: "rev-parse --verify --quiet --symbolic-full-name @{upstream}" },
  });
  const stdout = new Response(child.stdout).text(), stderr = new Response(child.stderr).text();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const bounded = new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error("Context fixture timed out.")), 5_000); });
    expect(await Promise.race([child.exited, bounded])).toBe(0);
  } finally {
    clearTimeout(timeout);
    if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.allSettled([child.exited, stdout, stderr]);
  }
  expect(await stderr).toBe("");
  expect(await stat(marker).then(() => true, () => false)).toBe(true);
  const outcome = JSON.parse(await stdout);
  expect(outcome).toEqual({ ok: false, name: "WorkspaceError", code: "GIT_FAILED" });
});

test("configured multi-ref and mirror push defaults require an explicit single-branch destination", async () => {
  const fixture = await repository();
  const remote = createBare(fixture.root, "origin");
  git(fixture.cwd, "remote", "add", "origin", remote);
  git(fixture.cwd, "config", "--add", "remote.origin.push", "refs/heads/*:refs/heads/*");
  let context = await readGitActionContext(fixture.service);
  expect(context.push).toMatchObject({ state: "unavailable", reason: "push-target-unresolved",
    alternatives: [{ remote: "origin", targetRef: "refs/heads/main" }] });
  git(fixture.cwd, "config", "--unset-all", "remote.origin.push");
  git(fixture.cwd, "config", "remote.origin.mirror", "1");
  context = await readGitActionContext(fixture.service);
  expect(context.push).toMatchObject({ state: "unavailable", reason: "push-target-unresolved",
    alternatives: [{ remote: "origin", targetRef: "refs/heads/main" }] });
});

test("a destination config change during inspection retries and returns only the stable context", async () => {
  const fixture = await repository();
  git(fixture.cwd, "remote", "add", "origin", createBare(fixture.root, "origin"));
  let reads = 0;
  const workspace = { cwd: fixture.service.cwd, gitStatus: async () => {
    const status = await fixture.service.gitStatus();
    reads++;
    if (reads === 2) git(fixture.cwd, "config", "push.default", "current");
    return status;
  }};
  const context = await readGitActionContext(workspace);
  expect(reads).toBeGreaterThanOrEqual(4);
  expect(context.push).toMatchObject({ state: "available", destination: { remote: "origin", targetRef: "refs/heads/main" } });
});
