import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "./runtime";

test("whole-chat copy preserves the retained native worker and history, copies artifacts, and never replaces a child", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-session-fork-")));
  const agentDir = join(root, "agent"), cwd = join(root, "source"), destination = join(root, "destination"), sessions = join(root, "sessions");
  const environment = { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" };
  let runtime: WorkerRuntime | undefined;
  try {
    await Promise.all([agentDir, cwd, destination, sessions].map(path => mkdir(path)));
    await writeFile(join(agentDir, "config.yml"), "extensions: []\n");
    // Seed through the real SDK in an isolated process, before any retained owner opens the file.
    const seed = Bun.spawn([process.execPath, "--no-env-file", "-e", `
      globalThis.fetch=Object.assign(async()=>{throw Error('No outbound fetch in Fork seed');},{preconnect(){}});
      // This loading-boundary test installs the fetch guard before SDK initialization; a static import would run first.
      const {SessionManager}=await import(${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-coding-agent"))});
      const manager=SessionManager.create(${JSON.stringify(cwd)},${JSON.stringify(sessions)});
      try {
        manager.appendMessage({role:'user',content:[{type:'text',text:'First owned history entry'}],timestamp:1});
        manager.appendMessage({role:'user',content:[{type:'text',text:'Second owned history entry'}],timestamp:2});
        manager.appendCustomEntry('fork-owned-context',{preserved:true});
        await manager.ensureOnDisk();await manager.flush();
        console.log(JSON.stringify({id:manager.getSessionId(),file:manager.getSessionFile()}));
      } finally { await manager.close(); }
    `], { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
    const [seedOutput, seedError, seedExit] = await Promise.all([new Response(seed.stdout).text(), new Response(seed.stderr).text(), seed.exited]);
    if (seedExit !== 0) throw new Error(`Native Fork seed failed: ${seedError}`);
    const original = JSON.parse(seedOutput) as { id: string; file: string };
    await mkdir(original.file.slice(0, -6));
    await writeFile(join(original.file.slice(0, -6), "output.txt"), "Owned native artifact\n");
    runtime = new WorkerRuntime({ agentDir, environment, startupTimeoutMs: 30_000,
      workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)) });
    const source = await runtime.open({ sessionFile: original.file });
    await source.flushSession();
    const sourceBytes = await readFile(original.file), history = await source.getMessages(), pid = source.workerPid;
    const request = { sourceSessionId: source.id, sourceSessionFile: source.sessionFile, cwd: destination,
      sessionDirectory: sessions, sessionFile: join(sessions, "owned-child.jsonl") };
    const receipt = await runtime.forkSession(request);
    expect(receipt.parentSessionId).toBe(original.id);
    expect(receipt.sessionId).not.toBe(original.id);
    expect(source.workerPid).toBe(pid);
    expect(source.id).toBe(original.id);
    expect(source.sessionFile).toBe(original.file);
    expect(source.cwd).toBe(cwd);
    expect(await source.getMessages()).toEqual(history);
    expect(await readFile(original.file)).toEqual(sourceBytes);
    expect(await readFile(join(receipt.sessionFile.slice(0, -6), "output.txt"), "utf8")).toBe("Owned native artifact\n");
    const child = await runtime.open({ sessionFile: receipt.sessionFile });
    expect(child.workerPid).not.toBe(pid);
    expect(child.cwd).toBe(destination);
    expect(await child.getMessages()).toEqual(history);
    expect(JSON.stringify(history)).toContain("First owned history entry");
    expect(JSON.stringify(history)).toContain("Second owned history entry");
    await child.flushSession();
    const childBytes = await readFile(receipt.sessionFile);
    await expect(runtime.forkSession(request)).rejects.toThrow();
    expect(await readFile(receipt.sessionFile)).toEqual(childBytes);
    expect(await readFile(original.file)).toEqual(sourceBytes);
  } finally {
    await runtime?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
