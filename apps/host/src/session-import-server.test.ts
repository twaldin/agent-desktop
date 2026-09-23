import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startHost } from "./server";
import { requestNativeImportInspection, requestNativeImportListing, requestNativeImportPreparation } from "../../desktop/src/main/session-import-transport";

test("real authenticated host and desktop transport inspect original native journals without importing or rewriting them", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "native-import-server-")));
  const agentDirectory = join(root, "agent"), project = join(root, "project"), dataDirectory = join(root, "data");
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await Promise.all([agentDirectory, project].map(directory => mkdir(directory)));
    await writeFile(join(agentDirectory, "config.yml"), "extensions: []\n");
    // Native creation is confined to a disposable child/profile. Discovery must
    // retain these existing directories rather than invoke native migration.
    const seeded = Bun.spawn([process.execPath, "--no-env-file", "-e", `
      globalThis.fetch=Object.assign(async()=>{throw Error('Import fixture outbound disabled');},{preconnect(){}});
      const {SessionManager}=await import(${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-coding-agent/session/session-manager"))});
      const {getSessionsDir}=await import(${JSON.stringify(import.meta.resolve("@oh-my-pi/pi-utils"))});
      const {mkdir}=await import('node:fs/promises');
      const directory=getSessionsDir(${JSON.stringify(agentDirectory)})+'/--preserved-legacy-project--';await mkdir(directory,{recursive:true});
      const manager=SessionManager.create(${JSON.stringify(project)},directory);
      manager.appendMessage({role:'user',content:'Original native import HTTP history',timestamp:1});
      await manager.ensureOnDisk();await manager.flush();
      const source={id:manager.getSessionId(),file:manager.getSessionFile(),directory};
      await manager.close();manager.seal();console.log(JSON.stringify(source));
    `], { cwd: project, env: { HOME: root, TMPDIR: root, PI_CODING_AGENT_DIR: agentDirectory, PATH: process.env.PATH, TERM: "dumb" }, stdout: "pipe", stderr: "pipe" });
    child = seeded;
    const [exit, stdout, stderr] = await Promise.all([seeded.exited, new Response(seeded.stdout).text(), new Response(seeded.stderr).text()]);
    if (exit !== 0) throw new Error(stderr);
    child = undefined;
    const original = JSON.parse(stdout) as { id: string; file: string; directory: string };
    const originalBytes = await readFile(original.file), originalNames = await readdir(original.directory);
    const options = { dataDirectory, agentDirectory, discoveryDirectory: project, port: 0, tailscale: false };
    host = await startHost(options);
    const endpoint = () => ({ origin: host!.connection.origin, token: host!.connection.token, hostId: host!.store.host.id });
    expect((await fetch(endpoint().origin + "/v1/session-imports", { headers: { "X-Agent-Host-Id": endpoint().hostId } })).status).toBe(401);
    expect((await fetch(endpoint().origin + "/v1/session-imports", { headers: { Authorization: `Bearer ${endpoint().token}`, "X-Agent-Host-Id": "foreign" } })).status).toBe(409);
    const listed = await requestNativeImportListing(endpoint(), new AbortController().signal);
    expect(listed.candidates).toHaveLength(1);
    const selected = listed.candidates[0]!;
    expect(selected.nativeId).toBe(original.id);
    const inspected = await requestNativeImportInspection(endpoint(), selected.candidateId, new AbortController().signal);
    expect(inspected.inspection).toMatchObject({ originalFile: original.file, nativeId: original.id, canonicalCwd: project, messages: 1,
      writeAdmission: { allowed: false, reason: "ownership-unverified" } });
    const refused=await requestNativeImportPreparation(endpoint(),{candidateId:selected.candidateId,revision:inspected.inspection.revision},new AbortController().signal);
    expect(refused.state).toBe("refused");
    expect(host.store.getSession(original.id)).toBeUndefined();
    expect(await readFile(original.file)).toEqual(originalBytes);
    expect(await readdir(original.directory)).toEqual(originalNames);
    await host.stop(); host = undefined;
    host = await startHost(options);
    // Opaque discovery IDs are process-local; a historical ID never rebinds.
    await expect(requestNativeImportInspection(endpoint(), selected.candidateId, new AbortController().signal)).rejects.toThrow();
    const reopened = await requestNativeImportListing(endpoint(), new AbortController().signal);
    expect(reopened.candidates[0]!.nativeId).toBe(original.id);
    expect(host.store.getSession(original.id)).toBeUndefined();
    expect(await readFile(original.file)).toEqual(originalBytes);
  } finally {
    if (child) { child.kill(); await child.exited; }
    await host?.stop();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);

test("public import confirms the original and cold reopening still requires its native writer ownership",async()=>{
  const evidence=process.env.SESSION_IMPORT_SERVER_EVIDENCE;
  if(evidence)await mkdir(evidence,{recursive:true});
  const root=await realpath(await mkdtemp(join(evidence??tmpdir(),"native-import-admission-server-")));
  const argv=[process.execPath,new URL("./fixtures/session-import-server-admission.ts",import.meta.url).pathname,root];
  const child=Bun.spawn(argv,{cwd:root,env:{HOME:root,TMPDIR:root,PI_CODING_AGENT_DIR:join(root,"agent"),PATH:process.env.PATH,TERM:"dumb"},stdout:"pipe",stderr:"pipe"});
  const deadline=setTimeout(()=>child.kill("SIGKILL"),90_000);
  try {
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    await writeFile(join(root,"run.json"),JSON.stringify({argv,exit,stdout,stderr},null,2));
    expect(exit,stderr+"\n"+stdout+"\nEvidence: "+root).toBe(0);
    if(!evidence)await rm(root,{recursive:true,force:true});
  } finally {clearTimeout(deadline);if(child.exitCode===null){child.kill("SIGKILL");await child.exited;}}
},95_000);
