import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceService } from "./service";
import { HostWorkspaces, parseWorkspaceQuery } from "../workspace-http";
import type { HostStore } from "../store";

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
function git(cwd:string,...args:string[]):string {
  const result=Bun.spawnSync(["git","-C",cwd,...args],{stdout:"pipe",stderr:"pipe",env:{PATH:process.env.PATH!,HOME:cwd,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null",LC_ALL:"C"}});
  if(!result.success)throw new Error(result.stderr.toString());return result.stdout.toString().trimEnd();
}
async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),"agent-branch-search-")));roots.push(root);
  const cwd=join(root,"repository");await mkdir(cwd);await mkdir(join(root,"no-hooks"));
  git(cwd,"init","--initial-branch=main");git(cwd,"config","user.name","Branch Fixture");git(cwd,"config","user.email","branch@example.invalid");
  git(cwd,"config","commit.gpgSign","false");git(cwd,"config","core.hooksPath",join(root,"no-hooks"));
  await writeFile(join(cwd,"tracked"),"committed\n");git(cwd,"add","tracked");git(cwd,"commit","-m","fixture");
  const head=git(cwd,"rev-parse","HEAD");
  for(const name of ["topic","topic-older","feature/λ"])git(cwd,"branch",name);
  git(cwd,"update-ref","refs/remotes/origin/topic",head);git(cwd,"update-ref","refs/remotes/other/topic",head);
  git(cwd,"symbolic-ref","refs/remotes/origin/HEAD","refs/remotes/origin/topic");
  await writeFile(join(cwd,"tracked"),"unstaged\n");await writeFile(join(cwd,"untracked"),"retain\n");
  const service=new WorkspaceService(cwd);
  const snapshot=async()=>({index:(await readFile(join(cwd,".git/index"))).toString("base64"),head:await readFile(join(cwd,".git/HEAD"),"utf8"),
    config:await readFile(join(cwd,".git/config"),"utf8"),refs:git(cwd,"for-each-ref","--format=%(refname)%00%(objectname)%00%(symref)"),
    tracked:await readFile(join(cwd,"tracked"),"utf8"),untracked:await readFile(join(cwd,"untracked"),"utf8")});
  return{root,cwd,head,service,snapshot};
}

test("branch query parser requires bounded literal text and a bounded positive limit",()=>{
  expect(parseWorkspaceQuery({type:"git.search-branches",query:" topic "})).toEqual({type:"git.search-branches",query:"topic",limit:20});
  expect(parseWorkspaceQuery({type:"git.search-branches",query:"--help",limit:1})).toEqual({type:"git.search-branches",query:"--help",limit:1});
  for(const query of ["","  ","x\n","x\0",12,"x".repeat(513)])expect(()=>parseWorkspaceQuery({type:"git.search-branches",query})).toThrow();
  for(const limit of [0,-1,101,1.1,"20",null])expect(()=>parseWorkspaceQuery({type:"git.search-branches",query:"topic",limit})).toThrow();
});

test("actual Git branch search preserves full local/remote identities and bytes without fetching or checking out",async()=>{
  const f=await fixture(),before=await f.snapshot();
  const result=await f.service.searchBranches("TOPIC",2);
  expect(result.limitReached).toBe(true);expect(result.branches.map(b=>b.ref)).toEqual(["refs/heads/topic","refs/heads/topic-older"]);
  const all=await f.service.searchBranches("topic",100);expect(all.limitReached).toBe(false);expect(all.branches).toHaveLength(2);
  expect(all.branches.every(b=>!b.remote)).toBe(true);
  expect((await f.service.searchBranches("refs/heads/topic",1)).branches).toEqual([]);
  expect((await f.service.searchBranches("λ")).branches[0]?.name).toBe("feature/λ");
  expect((await f.service.searchBranches("origin/HEAD")).branches).toEqual([]);
  expect((await f.service.searchBranches("--help")).branches).toEqual([]);
  expect((await f.service.searchBranches("main")).branches[0]?.current).toBe(true);
  expect(await f.snapshot()).toEqual(before);
  git(f.cwd,"branch","topic-new");const afterMutation=await f.snapshot();
  expect((await f.service.searchBranches("topic-new")).branches[0]?.name).toBe("topic-new");
  expect(await f.snapshot()).toEqual(afterMutation);
});

test("project query uses its containing Git repository and rejects a changed catalog owner",async()=>{
  const f=await fixture(),nested=join(f.cwd,"app");await mkdir(nested);
  let project={id:"project",hostId:"host",path:nested};
  const store={host:{id:"host"},getProject:(id:string)=>id==="project"?project:undefined,getSession:()=>undefined} as unknown as HostStore;
  const workspaces=new HostWorkspaces(store,join(f.root,"data"),()=>{throw new Error("Read-only query cannot reserve mutation");});
  const query=parseWorkspaceQuery({type:"git.search-branches",query:"topic",limit:1});
  const result=await workspaces.query({projectId:"project"},query);
  expect(result.type).toBe("git.search-branches");if(result.type!=="git.search-branches")throw new Error("Wrong result");
  expect(result.branches[0]?.ref).toBe("refs/heads/topic");expect(result.limitReached).toBe(true);
  await expect(workspaces.query({filePath:join(f.cwd,"tracked")},query)).rejects.toThrow();
  await expect(workspaces.query({projectId:"absent"},query)).rejects.toThrow();
  const original=WorkspaceService.prototype.searchBranches;
  WorkspaceService.prototype.searchBranches=async function(...args){const result=await original.apply(this,args);project={...project,path:join(f.root,"different")};return result;};
  try{await expect(workspaces.query({projectId:"project"},query)).rejects.toMatchObject({code:"WORKSPACE_CHANGED"});}
  finally{WorkspaceService.prototype.searchBranches=original;await workspaces.shutdownSubmissions();}
});
