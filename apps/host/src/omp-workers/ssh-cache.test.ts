import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "./runtime";

test("saving SSH settings invalidates the real existing native worker cache without a prompt or replacement", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "agent-ssh-cache-")));
  const cwd = path.join(root, "project"), agentDir = path.join(root, "agent"), output = path.join(root, "observation.json");
  await mkdir(path.join(cwd, ".git"), { recursive: true }); await mkdir(agentDir);
  await writeFile(path.join(agentDir, "config.yml"), "extensions: []\n");
  await writeFile(path.join(agentDir, "ssh.json"), JSON.stringify({ hosts: { chosen: { host: "before.invalid" } } }));
  const runtime = new WorkerRuntime({ agentDir, workerPath: fileURLToPath(new URL("./fixtures/ssh-cache-worker.ts", import.meta.url)),
    environment: { HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_DISABLE_DOTENV: "1", PATH: "/usr/bin:/bin", TMPDIR: root,
      SSH_CACHE_CWD: cwd, SSH_CACHE_OUTPUT: output, TERM: "dumb" } });
  try {
    const session = await runtime.create({ cwd }), pid = session.workerPid;
    const observe = async (sequence: number) => {
      process.kill(pid, "SIGUSR2");
      for (let i = 0; i < 300; i++) {
        try {
          const result = JSON.parse(await readFile(output, "utf8"));
          if (result.error) throw new Error(result.error);
          if (result.sequence === sequence) return result;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
        await Bun.sleep(10);
      }
      throw new Error("Owned worker cache observation timed out");
    };
    expect((await observe(1)).hosts).toEqual([{ name: "chosen", host: "before.invalid" }]);
    const catalog = await runtime.getSshHosts(cwd);
    const saved = await runtime.mutateSshHost(cwd, { operation: "update", hostId: catalog.hosts[0]!.id,
      expectedRevision: catalog.revision, config: { host: "after.invalid" } });
    expect(saved.warnings).toEqual([]);
    expect(await observe(2)).toMatchObject({ pid, hosts: [{ name: "chosen", host: "after.invalid" }] });
    expect(session.workerPid).toBe(pid); expect(session.workerFailure).toBeUndefined();
    expect(await session.getMessages()).toEqual([]);
    await session.dispose();
    expect(() => process.kill(pid, 0)).toThrow();
  } finally { await runtime.dispose(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
