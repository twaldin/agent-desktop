import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceService } from "./service";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(new TextDecoder().decode(result.stderr));
  return new TextDecoder().decode(result.stdout).trim();
}

async function repository(commit = true) {
  const directory = await mkdtemp(join(tmpdir(), "agent-desktop-commit-outcome-"));
  directories.push(directory);
  const cwd = join(directory, "project");
  const hooks = join(directory, "hooks");
  await mkdir(cwd);
  await mkdir(hooks);
  git(cwd, "init", "--initial-branch=main");
  git(cwd, "config", "user.name", "Workspace Test");
  git(cwd, "config", "user.email", "workspace-tests@example.invalid");
  git(cwd, "config", "commit.gpgSign", "false");
  git(cwd, "config", "core.hooksPath", hooks);
  await writeFile(join(cwd, "tracked.txt"), "base\n");
  if (commit) {
    git(cwd, "add", "--", "tracked.txt");
    git(cwd, "commit", "--message", "Initial fixture");
  }
  return { directory, cwd, hooks };
}

async function stageChange(cwd: string, contents: string) {
  await writeFile(join(cwd, "tracked.txt"), contents);
  git(cwd, "add", "--", "tracked.txt");
}

async function waitForFile(path: string, timeoutMs = 4_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await stat(path).then(() => true, () => false)) return;
    await Bun.sleep(10);
  }
  throw new Error(`Timed out waiting for hook signal: ${path}`);
}

function settled<T>(promise: Promise<T>): Promise<{ value: T } | { error: unknown }> {
  return promise.then(value => ({ value }), error => ({ error }));
}

describe("commit outcome receipts", () => {
  test("a post-commit timeout is uncertain after HEAD advances and creates exactly one commit", async () => {
    const { cwd, hooks } = await repository();
    const advanced = join(cwd, ".post-commit-advanced");
    const completed = join(cwd, ".post-commit-completed");
    await writeFile(join(hooks, "post-commit"), "#!/bin/sh\nprintf advanced > .post-commit-advanced\n/bin/sleep 5\nprintf completed > .post-commit-completed\n");
    await chmod(join(hooks, "post-commit"), 0o755);
    await stageChange(cwd, "committed before hook completed\n");
    const before = git(cwd, "rev-parse", "HEAD");
    const service = new WorkspaceService(cwd, { gitTimeoutMs: 2_000 });
    const outcome = settled(service.commit("Delayed hook commit"));
    let reached = false;
    try {
      await waitForFile(advanced);
      reached = true;
      expect(git(cwd, "rev-parse", "HEAD")).not.toBe(before);
      expect(await outcome).toMatchObject({ error: { code: "OUTCOME_UNKNOWN" } });
      const after = git(cwd, "rev-parse", "HEAD");
      expect(after).not.toBe(before);
      expect(git(cwd, "rev-list", "--count", "HEAD")).toBe("2");
      expect(git(cwd, "log", "-1", "--format=%s")).toBe("Delayed hook commit");
    } finally {
      await outcome;
      if (reached) await waitForFile(completed, 6_000);
    }
  }, { timeout: 15_000 });

  test("a post-commit hook moving HEAD does not turn a foreign commit into this receipt", async () => {
    const { cwd, hooks } = await repository();
    await writeFile(join(hooks, "post-commit"), "#!/bin/sh\nforeign=$(git commit-tree HEAD^{tree} -p HEAD -m 'Foreign post-commit commit')\ngit update-ref HEAD \"$foreign\" HEAD\n");
    await chmod(join(hooks, "post-commit"), 0o755);
    await stageChange(cwd, "original commit before foreign head\n");
    const before = git(cwd, "rev-parse", "HEAD");
    const service = new WorkspaceService(cwd, { gitTimeoutMs: 5_000 });

    await expect(service.commit("Original receipt commit")).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });

    const after = git(cwd, "rev-parse", "HEAD");
    expect(after).not.toBe(before);
    expect(git(cwd, "log", "-1", "--format=%s")).toBe("Foreign post-commit commit");
    expect(git(cwd, "rev-list", "--count", "HEAD")).toBe("3");
  });

  test("a pre-commit rejection remains a definite ordinary failure with no new HEAD", async () => {
    const { cwd, hooks } = await repository();
    await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nexit 17\n");
    await chmod(join(hooks, "pre-commit"), 0o755);
    await stageChange(cwd, "rejected before commit\n");
    const before = git(cwd, "rev-parse", "HEAD");
    const service = new WorkspaceService(cwd, { gitTimeoutMs: 5_000 });

    await expect(service.commit("Rejected hook commit")).rejects.toMatchObject({ code: "GIT_FAILED" });

    expect(git(cwd, "rev-parse", "HEAD")).toBe(before);
    expect(git(cwd, "rev-list", "--count", "HEAD")).toBe("1");
  });

  test("a pre-commit timeout is uncertain even when the immediate HEAD is unchanged", async () => {
    const { cwd, hooks } = await repository();
    const reached = join(cwd, ".pre-commit-reached");
    const completed = join(cwd, ".pre-commit-completed");
    await writeFile(join(hooks, "pre-commit"), "#!/bin/sh\nprintf reached > .pre-commit-reached\n/bin/sleep 5\nprintf completed > .pre-commit-completed\n");
    await chmod(join(hooks, "pre-commit"), 0o755);
    await stageChange(cwd, "timed out before commit\n");
    const before = git(cwd, "rev-parse", "HEAD");
    const service = new WorkspaceService(cwd, { gitTimeoutMs: 2_000 });
    const outcome = settled(service.commit("Timed out hook commit"));
    let hookReached = false;
    try {
      await waitForFile(reached);
      hookReached = true;
      expect(git(cwd, "rev-parse", "HEAD")).toBe(before);
      expect(await outcome).toMatchObject({ error: { code: "OUTCOME_UNKNOWN" } });
      expect(git(cwd, "rev-parse", "HEAD")).toBe(before);
      expect(git(cwd, "rev-list", "--count", "HEAD")).toBe("1");
    } finally {
      await outcome;
      if (hookReached) await waitForFile(completed, 6_000);
    }
  }, { timeout: 15_000 });

  test("a successful receipt names the exact commit that Git created", async () => {
    const { cwd } = await repository();
    await stageChange(cwd, "verified receipt\n");
    const service = new WorkspaceService(cwd, { gitTimeoutMs: 1_000 });

    const result = await service.commit("Verified receipt commit");

    expect(result.commit).toBe(git(cwd, "rev-parse", "HEAD"));
    expect(git(cwd, "show", "-s", "--format=%s", result.commit)).toBe("Verified receipt commit");
  });

  test("a commit subject ending in a hexadecimal token and ] does not replace the header receipt", async () => {
    const { cwd } = await repository();
    await stageChange(cwd, "subject delimiter\n");
    const service = new WorkspaceService(cwd, { gitTimeoutMs: 1_000 });

    const result = await service.commit("Mention deadbeef]");

    expect(result.commit).toBe(git(cwd, "rev-parse", "HEAD"));
    expect(git(cwd, "show", "-s", "--format=%s", result.commit)).toBe("Mention deadbeef]");
  });

  test("a hexadecimal token and ] in the middle of a commit subject does not replace the header receipt", async () => {
    const { cwd } = await repository();
    await stageChange(cwd, "middle subject delimiter\n");
    const service = new WorkspaceService(cwd, { gitTimeoutMs: 1_000 });

    const result = await service.commit("Mention deadbeef] again");

    expect(result.commit).toBe(git(cwd, "rev-parse", "HEAD"));
    expect(git(cwd, "show", "-s", "--format=%s", result.commit)).toBe("Mention deadbeef] again");
  });

  test("a four-character receipt and a branch name containing ] remain verifiable", async () => {
    const { cwd } = await repository();
    git(cwd, "branch", "-m", "receipt]branch");
    git(cwd, "config", "core.abbrev", "4");
    await stageChange(cwd, "short receipt\n");
    const service = new WorkspaceService(cwd, { gitTimeoutMs: 1_000 });

    const result = await service.commit("Short receipt commit");

    expect(result.commit).toBe(git(cwd, "rev-parse", "HEAD"));
    expect(git(cwd, "branch", "--show-current")).toBe("receipt]branch");
  });

  test("a detached-HEAD commit receipt remains verifiable", async () => {
    const { cwd } = await repository();
    git(cwd, "checkout", "--detach");
    await stageChange(cwd, "detached receipt\n");
    const service = new WorkspaceService(cwd, { gitTimeoutMs: 1_000 });

    const result = await service.commit("Detached receipt commit");

    expect(result.commit).toBe(git(cwd, "rev-parse", "HEAD"));
    expect(git(cwd, "branch", "--show-current")).toBe("");
  });

  test("an unborn repository verifies its first commit receipt", async () => {
    const { cwd } = await repository(false);
    await stageChange(cwd, "initial commit\n");
    const service = new WorkspaceService(cwd, { gitTimeoutMs: 1_000 });

    const result = await service.commit("Initial receipt commit");

    expect(result.commit).toBe(git(cwd, "rev-parse", "HEAD"));
    expect(git(cwd, "log", "-1", "--format=%s")).toBe("Initial receipt commit");
  });
});
