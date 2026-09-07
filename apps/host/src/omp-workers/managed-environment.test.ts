import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerRuntime } from "./runtime";

test("managed worker establishes selected agent directory before SDK imports and ignores HOME dotenv", async () => {
  const root=await realpath(await mkdtemp(join(tmpdir(),"managed-worker-env-")));
  const agentDir=join(root,"selected"), wrong=join(root,"wrong"), cwd=join(root,"project"), observed=join(root,"observed.json");
  let runtime:WorkerRuntime|undefined;
  try {
    await Promise.all([agentDir,wrong,cwd,join(agentDir,"skills/managed-owned")].map(p=>mkdir(p,{recursive:true})));
    await writeFile(join(agentDir,"config.yml"),"extensions: []\nskills:\n  enabled: true\n");
    await writeFile(join(wrong,"config.yml"),"extensions: []\nskills:\n  enabled: false\n");
    await writeFile(join(agentDir,"skills/managed-owned/SKILL.md"),"---\nname: managed-owned\ndescription: Explicit profile skill\n---\nOwned skill\n");
    await writeFile(join(root,".env"),`PI_CONFIG_FILES=${join(wrong,"config.yml")}\nMANAGED_DOTENV_SENTINEL=bad\n`);
    const worker=join(root,"worker.ts");
    await writeFile(worker,`await Bun.write(${JSON.stringify(observed)}, JSON.stringify({home:process.env.HOME,agentDir:process.env.PI_CODING_AGENT_DIR,noEnv:process.execArgv.includes('--no-env-file'),flag:process.env.PI_DISABLE_DOTENV,explicit:process.env.MANAGED_EXPLICIT}));\nawait import(${JSON.stringify(new URL("./entry.ts",import.meta.url).href)});\n`);
    runtime=new WorkerRuntime({agentDir,workerPath:worker,environment:{HOME:root,PATH:process.env.PATH,TMPDIR:tmpdir(),TERM:"dumb",PI_DISABLE_DOTENV:"1",PI_CODING_AGENT_DIR:wrong,MANAGED_EXPLICIT:"retained"}});
    const inventory=await runtime.getSkillInventory(cwd);
    expect(inventory.enabled).toBe(true);
    expect(inventory.skills.some(row=>row.name==="managed-owned")).toBe(true);
    expect(JSON.parse(await readFile(observed,"utf8"))).toEqual({home:root,agentDir,noEnv:true,flag:"1",explicit:"retained"});
    expect(await readFile(join(agentDir,"config.yml"),"utf8")).toBe("extensions: []\nskills:\n  enabled: true\n");
  } finally { await runtime?.dispose();await rm(root,{recursive:true,force:true}); }
},30_000);
