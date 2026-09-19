import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "./runtime";
test("real native exporter preserves session identity, includes ordered hostile/tool content and changes native theme palette", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-html-export-"))), agentDir = join(root, "agent"), cwd = join(root, "project"), sessions = join(root, "sessions");
  const environment = { HOME: root, PATH: process.env.PATH, TMPDIR: tmpdir(), PI_CODING_AGENT_DIR: agentDir, TERM: "dumb" };
  let runtime: WorkerRuntime | undefined;
  try {
    await Promise.all([agentDir, cwd, sessions].map(path => mkdir(path)));
    await writeFile(join(agentDir, "config.yml"), "extensions: []\n");
    const seed = Bun.spawn([process.execPath, "--no-env-file", "-e", `
      globalThis.fetch=Object.assign(async()=>{throw Error('No outbound fetch in export seed');},{preconnect(){}});
      const {SessionManager}=await import(${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-coding-agent"))});
      const manager=SessionManager.create(${JSON.stringify(cwd)},${JSON.stringify(sessions)});
      try {
        manager.appendMessage({role:'user',content:[{type:'text',text:'First entry </script><script>alert("hostile")</script>'}],timestamp:1});
        manager.appendMessage({role:'toolResult',toolCallId:'tool',toolName:'read',content:[{type:'text',text:'Owned tool result'}],isError:false,timestamp:2});
        manager.appendMessage({role:'user',content:[{type:'text',text:'Last entry'}],timestamp:3});
        await manager.ensureOnDisk();await manager.flush(); console.log(JSON.stringify({id:manager.getSessionId(),file:manager.getSessionFile()}));
      } finally { await manager.close(); }
    `], { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(seed.stdout).text(), new Response(seed.stderr).text(), seed.exited]);
    if (code) throw new Error(err);
    const original = JSON.parse(out) as { id: string; file: string };
    runtime = new WorkerRuntime({ agentDir, environment, startupTimeoutMs: 30_000, workerPath: fileURLToPath(new URL("./fixtures/no-provider-worker.ts", import.meta.url)) });
    const session = await runtime.open({ sessionFile: original.file }), before = await readFile(original.file), pid = session.workerPid;
    expect(await session.getExportIntent("/export --themes")).toEqual({ theme: "user" });
    for (const arg of ["--copy", "clipboard", "copy"]) expect(await session.getExportIntent(`/export ${arg}`)).toMatchObject({ guidance: "Use /dump to copy the session to clipboard." });
    expect(await session.getExportIntent("/export /tmp/client.html")).toMatchObject({ guidance: expect.stringContaining("Save as") });
    const request = { sessionId: session.id, sessionFile: session.sessionFile, cwd: session.cwd, outputPath: join(root, "web.html"), theme: "web" as const, text: "/export" };
    await session.exportSession(request);
    const html = await readFile(request.outputPath, "utf8");
    expect(html).toContain("<!DOCTYPE html>"); expect(html).not.toContain('</script><script>alert("hostile")</script>');
    // The pinned exporter stores the full native session as base64 JSON in the standalone viewer.
    const embedded = /<script id="session-data" type="application\/json">([A-Za-z0-9+/=]+)<\/script>/.exec(html);
    if (!embedded) throw new Error("Native embedded session-data marker changed");
    const data = Buffer.from(embedded[1]!, "base64").toString("utf8");
    expect(data.indexOf("First entry")).toBeLessThan(data.indexOf("Owned tool result")); expect(data.indexOf("Owned tool result")).toBeLessThan(data.indexOf("Last entry"));
    await session.exportSession({ ...request, outputPath: join(root, "user.html"), theme: "user", text: "/export --themes" });
    expect(await readFile(join(root, "user.html"), "utf8")).not.toBe(html);
    await expect(session.exportSession({ ...request, sessionId: "foreign" })).rejects.toThrow("original saved native session");
    expect(session.id).toBe(original.id); expect(session.workerPid).toBe(pid); expect(await readFile(original.file)).toEqual(before);
  } finally { await runtime?.dispose(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
