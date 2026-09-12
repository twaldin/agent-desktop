import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerRuntime } from "./runtime";

const cleanup:Array<()=>Promise<void>>=[];
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse()) await fn();});

test("moves the actual native session in place without changing its identity, file, history, or browser owner",async()=>{
  const directory=await realpath(await mkdtemp(join(tmpdir(),"native-task-location-"))); cleanup.push(()=>rm(directory,{recursive:true,force:true}));
  const agentDir=join(directory,"agent"),source=join(directory,"source"),destination=join(directory,"destination");
  await mkdir(agentDir,{recursive:true}); await mkdir(source); await mkdir(destination);
  await writeFile(join(agentDir,"config.yml"),"extensions: []\n");
  const runtime=new WorkerRuntime({agentDir,workerPath:fileURLToPath(new URL("./fixtures/no-provider-worker.ts",import.meta.url)),environment:{HOME:directory,PATH:process.env.PATH,TMPDIR:tmpdir(),PI_CODING_AGENT_DIR:agentDir,TERM:"dumb"},startupTimeoutMs:30_000}); cleanup.push(()=>runtime.dispose());
  const session=await runtime.create({cwd:source}); const before={id:session.id,file:session.sessionFile,messages:await session.getMessages(),browser:await session.getBrowserMetadata()};
  const receipt=await session.moveSession(destination);
  expect(receipt).toEqual({id:before.id,cwd:await realpath(destination),sessionFile:before.file});
  expect(session.id).toBe(before.id); expect(session.sessionFile).toBe(before.file); expect(session.cwd).toBe(await realpath(destination));
  expect(await session.getMessages()).toEqual(before.messages); expect(await session.getBrowserMetadata()).toEqual(before.browser);
  const entries=(await readFile(before.file,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
  const destinationReal=await realpath(destination);
  expect(entries.some(entry=>entry.id===before.id&&entry.cwd===destinationReal)).toBe(true);
},60_000);
