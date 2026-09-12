import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);

test("owned OMP generates from the supplied selection without staging unrelated live changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-commit-generation-"));
  const cwd = join(root, "repository");
  const env = {
    HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "agent"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin", TMPDIR: root, LANG: "en_US.UTF-8", TERM: "dumb",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = async (...args: string[]) => (await execute("git", args, { cwd, env, timeout: 10_000 })).stdout;
  try {
    await Promise.all([cwd, env.HOME, env.PI_CODING_AGENT_DIR, join(root, "hooks")].map(path => mkdir(path)));
    await git("init", "-q", "--initial-branch=main");
    await git("config", "user.name", "Commit Contract");
    await git("config", "user.email", "fixture@example.invalid");
    await git("config", "commit.gpgSign", "false");
    await git("config", "core.hooksPath", join(root, "hooks"));
    await writeFile(join(cwd, "source.js"), "const value=1;\n");
    await writeFile(join(cwd, "other.js"), "const other = 1;\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    await writeFile(join(cwd, "source.js"), "const value = 1;\n");
    await writeFile(join(cwd, "other.js"), "const other = 2;\n");
    await git("add", "other.js");
    const paths = [".git/index", ".git/config", ".git/HEAD", "source.js", "other.js"];
    const before = await Promise.all(paths.map(path => readFile(join(cwd, path))));
    const head = await git("rev-parse", "HEAD");
    const inputPath = join(root, "input.json");
    await writeFile(inputPath, JSON.stringify({ cwd,
      diff: await git("diff", "--", "source.js"),
      stat: await git("diff", "--stat", "--", "source.js"),
      numstat: await git("diff", "--numstat", "--", "source.js"),
    }));
    const child = await execute(process.execPath, [
      fileURLToPath(new URL("./fixtures/commit-generation-probe.ts", import.meta.url)), inputPath,
    ], { cwd, env, timeout: 20_000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(child.stdout);
    // Whitespace uses the native deterministic fast path; this is not provider proof.
    expect(result.result.commit).toMatchObject({ type: "style", summary: "reformatted source.js" });
    expect(result.result.validationError).toBeNull();
    expect(result.result.stagedAll).toBe(false);
    expect(result.fetchCalls).toBe(0);
    expect(result.aborted).toBe("contract-canceled");
    expect(result.empty).toBe("No changes to analyze");
    expect(await git("rev-parse", "HEAD")).toBe(head);
    for (const [index, path] of paths.entries()) expect(await readFile(join(cwd, path))).toEqual(before[index]!);
    expect((await git("diff", "--cached", "--name-only")).trim()).toBe("other.js");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
