import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Project, SessionSummary } from "@agent-desktop/shared";
import { TaskLocations } from "./task-location";

const roots:string[]=[];
afterEach(async()=>{while(roots.length) await rm(roots.pop()!,{recursive:true,force:true});});
const git=(cwd:string,...args:string[])=>execFileSync("git",["-C",cwd,...args],{encoding:"utf8",env:{...process.env,GIT_AUTHOR_NAME:"Fixture",GIT_AUTHOR_EMAIL:"fixture@example.invalid",GIT_COMMITTER_NAME:"Fixture",GIT_COMMITTER_EMAIL:"fixture@example.invalid"}}).trim();

async function fixture(){
  const root=await mkdtemp(join(tmpdir(),"task-location-")); roots.push(root);
  const repo=join(root,"repo"),data=join(root,"data");
  execFileSync("mkdir",["-p",repo]); git(repo,"init","-b","main"); await writeFile(join(repo,"tracked.txt"),"base\n"); git(repo,"add","."); git(repo,"commit","-m","base"); git(repo,"checkout","-b","feature");
  const project:Project={id:"project",hostId:"host",name:"Project",path:repo,createdAt:1};
  let session:SessionSummary={id:"session",hostId:"host",projectId:project.id,cwd:repo,title:"Task",status:"idle",sessionFile:join(root,"session.jsonl"),model:null,createdAt:1,updatedAt:1,archived:false};
  const reads:Promise<unknown>[]=[]; let observe=false;
  const metadata=new Map<string,unknown>(); let nativeCwd=repo, failMove=false,failReserve=false,failNativeReady=false,changeDuringReady=false;
  const store={host:{id:"host"},listSessions:()=>[session],getSession:(id:string)=>id===session.id?session:undefined,getProject:(id:string)=>id===project.id?project:undefined,upsertSession:(value:SessionSummary)=>(session=value),readMetadata:<T>(key:string)=>metadata.get(key) as T|undefined,writeMetadata:<T>(key:string,value:T)=>{metadata.set(key,structuredClone(value));}};
  const handle={id:session.id,get cwd(){return nativeCwd;},sessionFile:session.sessionFile,isStreaming:false,hasPostPromptWork:false,assertTaskLocationReady:async()=>{if(changeDuringReady){changeDuringReady=false;await writeFile(join(repo,"during-ready.txt"),"changed\n");}if(failNativeReady){failNativeReady=false;throw new Error("native side work is pending");}},moveSession:async(cwd:string)=>{if(failMove){failMove=false;throw new Error("lost native acknowledgement");}nativeCwd=await import("node:fs/promises").then(fs=>fs.realpath(cwd));return{id:session.id,cwd:nativeCwd,sessionFile:session.sessionFile};}};
  const dependencies={store,dataDirectory:data,getHandle:async()=>handle as never,publish:()=>{if(observe) reads.push(service.get("session").catch(()=>undefined));},publishState:()=>{},reserve:()=>{if(failReserve){failReserve=false;throw new Error("workspace reserved");}return()=>{};}};
  let service=new TaskLocations(dependencies);
  return{root,repo,data,observeMoves(){observe=true;},async settleReads(){await Promise.all(reads);},get service(){return service;},get session(){return session;},get nativeCwd(){return nativeCwd;},setStatus(status:SessionSummary["status"]){session={...session,status};},failNextMove(){failMove=true;},failNextReserve(){failReserve=true;},failNextNativeReady(){failNativeReady=true;},changeOnNativeReady(){changeDuringReady=true;},restartWithRunningRecord(){const key=`task-location.v1:${session.id}`;const value=structuredClone(metadata.get(key)) as {status:string};value.status="running";metadata.set(key,value);service=new TaskLocations(dependencies);},rewindUnknownToCapture(){const key=`task-location.v1:${session.id}`;const value=structuredClone(metadata.get(key)) as {step:string;status:string;stashCommit?:string};value.step="capture-changes";value.status="unknown";delete value.stashCommit;metadata.set(key,value);}};
}

test("moves one existing native task to a managed worktree and back with index and files intact",async()=>{
  const f=await fixture();
  await writeFile(join(f.repo,"tracked.txt"),"staged\n"); git(f.repo,"add","tracked.txt");
  await writeFile(join(f.repo,"tracked.txt"),"working\n"); await writeFile(join(f.repo,"untracked.txt"),"new\n"); await writeFile(join(f.repo,".gitignore"),"ignored.bin\n"); await writeFile(join(f.repo,"ignored.bin"),"ignored\n");
  const before=await f.service.get("session"); expect(before.current).toMatchObject({kind:"local",branch:"feature",dirty:true});
  expect(before.localCheckoutBranches).toEqual(["main"]);
  const moved=await f.service.move("move-out","session",before.revision,{kind:"worktree",branch:"feature",localCheckoutBranch:"main"});
  expect(moved.session.id).toBe("session"); expect(moved.session.cwd).toBe(f.nativeCwd); expect(moved.operation.status).toBe("succeeded");
  expect(git(f.repo,"branch","--show-current")).toBe("main");
  expect(git(moved.session.cwd,"branch","--show-current")).toBe("feature");
  expect(await readFile(join(moved.session.cwd,"tracked.txt"),"utf8")).toBe("working\n");
  expect(await readFile(join(moved.session.cwd,"untracked.txt"),"utf8")).toBe("new\n");
  expect(await readFile(join(moved.session.cwd,"ignored.bin"),"utf8")).toBe("ignored\n");
  expect(git(moved.session.cwd,"diff","--cached","--","tracked.txt")).toContain("+staged");
  expect(git(moved.session.cwd,"diff","--","tracked.txt")).toContain("+working");

  const returnView=await f.service.get("session"); expect(returnView.local.available).toBe(true);
  const returned=await f.service.move("move-back","session",returnView.revision,{kind:"local",branch:"feature"});
  expect(returned.session).toMatchObject({id:"session",cwd:await import("node:fs/promises").then(fs=>fs.realpath(f.repo))}); expect(f.nativeCwd).toBe(returned.session.cwd);
  expect(git(f.repo,"branch","--show-current")).toBe("feature");
  expect(await readFile(join(f.repo,"tracked.txt"),"utf8")).toBe("working\n");
  expect(await readFile(join(f.repo,"untracked.txt"),"utf8")).toBe("new\n");
  expect(await readFile(join(f.repo,"ignored.bin"),"utf8")).toBe("ignored\n");
  expect(git(f.repo,"diff","--cached","--","tracked.txt")).toContain("+staged");
},15_000);

test("rejects stale views and dirty local destinations without dispatching native relocation",async()=>{
  const f=await fixture(); const first=await f.service.get("session");
  await writeFile(join(f.repo,"tracked.txt"),"changed\n");
  await expect(f.service.move("stale","session",first.revision,{kind:"worktree",branch:"feature",localCheckoutBranch:"main"})).rejects.toMatchObject({code:"TASK_LOCATION_CHANGED"});
  expect(f.nativeCwd).toBe(f.repo);
},15_000);

test("reports a conflicted checkout as unavailable without trying to synthesize a tree",async()=>{
  const f=await fixture(); git(f.repo,"checkout","main"); await writeFile(join(f.repo,"tracked.txt"),"main\n"); git(f.repo,"add","tracked.txt"); git(f.repo,"commit","-m","main change");
  git(f.repo,"checkout","feature"); await writeFile(join(f.repo,"tracked.txt"),"feature\n"); git(f.repo,"add","tracked.txt"); git(f.repo,"commit","-m","feature change");
  expect(()=>git(f.repo,"merge","main")).toThrow();
  const snapshot=await f.service.get("session");
  expect(snapshot.current.conflicted).toBe(true); expect(snapshot.worktree).toMatchObject({available:false,reason:"Resolve Git conflicts before moving this task."});
},15_000);

test("fences exact reviewed HEAD and selected working content before creating an operation",async()=>{
  const f=await fixture(); await writeFile(join(f.repo,"tracked.txt"),"first\n");
  git(f.repo,"config","core.trustctime","false"); git(f.repo,"config","core.checkStat","minimal");
  const dirty=await f.service.get("session"), metadata=await stat(join(f.repo,"tracked.txt"));
  await writeFile(join(f.repo,"tracked.txt"),"other\n"); await utimes(join(f.repo,"tracked.txt"),metadata.atime,metadata.mtime);
  await expect(f.service.move("changed-bytes","session",dirty.revision,{kind:"worktree",branch:"feature",localCheckoutBranch:"main"})).rejects.toMatchObject({code:"TASK_LOCATION_CHANGED"});
  git(f.repo,"add","tracked.txt"); git(f.repo,"commit","-m","new head");
  await expect(f.service.move("changed-head","session",dirty.revision,{kind:"worktree",branch:"feature",localCheckoutBranch:"main"})).rejects.toMatchObject({code:"TASK_LOCATION_CHANGED"});
  expect(f.nativeCwd).toBe(f.repo);
},15_000);

test("revalidates exact Git state after native readiness before the first mutation",async()=>{
  const f=await fixture(), before=await f.service.get("session"); f.changeOnNativeReady();
  await expect(f.service.move("readiness-race","session",before.revision,{kind:"worktree",branch:"feature",localCheckoutBranch:"main"})).rejects.toMatchObject({code:"TASK_LOCATION_CHANGED"});
  expect(git(f.repo,"branch","--show-current")).toBe("feature"); expect(git(f.repo,"stash","list")).toBe("");
  expect((await f.service.get("session")).operation).toMatchObject({id:"readiness-race",status:"failed",step:"validate"});
},15_000);

test("admits only one move when two requests inspect the same revision concurrently",async()=>{
  const f=await fixture(), before=await f.service.get("session"), target={kind:"worktree" as const,branch:"feature",localCheckoutBranch:"main"};
  const outcomes=await Promise.allSettled([f.service.move("concurrent-a","session",before.revision,target),f.service.move("concurrent-b","session",before.revision,target)]);
  expect(outcomes.filter(value=>value.status==="fulfilled")).toHaveLength(1);
  const rejected=outcomes.find(value=>value.status==="rejected") as PromiseRejectedResult;
  expect(rejected.reason).toMatchObject({code:"TASK_LOCATION_CHANGED"});
  const final=await f.service.get("session"); expect(final.operation).toMatchObject({status:"succeeded"}); expect(final.current.kind).toBe("worktree");
},15_000);

test("retains and reconciles an actual stash created by a failing Git invocation",async()=>{
  const f=await fixture(), bin=join(f.root,"bin"), wrapper=join(bin,"git"), marker=join(f.root,"stash-failed-once");
  await writeFile(join(f.repo,"tracked.txt"),"changed\n"); const before=await f.service.get("session"); await mkdir(bin);
  await writeFile(wrapper,`#!/bin/sh
/usr/bin/git "$@"
code=$?
case "$*" in
  *"stash push --all"*)
    if [ ! -e ${JSON.stringify(marker)} ]; then : > ${JSON.stringify(marker)}; exit 41; fi
  ;;
esac
exit "$code"
`); await chmod(wrapper,0o700);
  const previous=process.env.PATH; process.env.PATH=`${bin}:${previous}`;
  try {
    await expect(f.service.move("failed-stash","session",before.revision,{kind:"worktree",branch:"feature",localCheckoutBranch:"main"})).rejects.toMatchObject({code:"OUTCOME_UNKNOWN"});
  } finally { process.env.PATH=previous; }
  const unknown=await f.service.get("session"); expect(unknown.operation).toMatchObject({id:"failed-stash",status:"unknown",step:"capture-changes"});
  expect(git(f.repo,"stash","list")).toContain("agent-desktop-location:failed-stash");
  const resumed=await f.service.resume("session","failed-stash",unknown.revision);
  expect(resumed.operation).toMatchObject({id:"failed-stash",status:"succeeded"});
  expect(await readFile(join(resumed.session.cwd,"tracked.txt"),"utf8")).toBe("changed\n");
},15_000);

test("busy or reserved admission fails without stranding the task location operation",async()=>{
  const f=await fixture(); const before=await f.service.get("session"); f.setStatus("running");
  await expect(f.service.move("busy","session",before.revision,{kind:"worktree",branch:"feature",localCheckoutBranch:"main"})).rejects.toMatchObject({code:"SESSION_BUSY"});
  expect((await f.service.get("session")).operation).toMatchObject({id:"busy",status:"failed"});
  f.setStatus("idle"); const retry=await f.service.get("session"); f.failNextReserve();
  await expect(f.service.move("reserved","session",retry.revision,{kind:"worktree",branch:"feature",localCheckoutBranch:"main"})).rejects.toThrow("workspace reserved");
  expect((await f.service.get("session")).operation).toMatchObject({id:"reserved",status:"failed"});
  const nativeBusy=await f.service.get("session"); f.failNextNativeReady();
  await expect(f.service.move("native-busy","session",nativeBusy.revision,{kind:"worktree",branch:"feature",localCheckoutBranch:"main"})).rejects.toThrow("native side work is pending");
  expect(git(f.repo,"branch","--show-current")).toBe("feature"); expect(git(f.repo,"stash","list")).toBe("");
  const usable=await f.service.get("session");
  expect((await f.service.move("usable","session",usable.revision,{kind:"worktree",branch:"feature",localCheckoutBranch:"main"})).operation.status).toBe("succeeded");
},15_000);


test("retains one unknown operation after a lost native move and resumes without repeating Git transfer",async()=>{
  const f=await fixture(); await writeFile(join(f.repo,"tracked.txt"),"queued\n");
  const before=await f.service.get("session"); f.failNextMove();
  await expect(f.service.move("recoverable","session",before.revision,{kind:"worktree",branch:"feature",localCheckoutBranch:"main"})).rejects.toMatchObject({code:"OUTCOME_UNKNOWN"});
  const unknown=await f.service.get("session"); expect(unknown.operation).toMatchObject({id:"recoverable",status:"unknown",step:"move-session"});
  f.restartWithRunningRecord(); const restarted=await f.service.get("session"); expect(restarted.operation).toMatchObject({id:"recoverable",status:"unknown",step:"move-session"});
  await expect(f.service.move("replacement","session",restarted.revision,{kind:"worktree",branch:"feature",localCheckoutBranch:"main"})).rejects.toMatchObject({code:"OPERATION_REQUIRES_RECOVERY"});
  f.failNextReserve(); await expect(f.service.resume("session","recoverable",restarted.revision)).rejects.toThrow("workspace reserved");
  const stillUnknown=await f.service.get("session"); expect(stillUnknown.operation).toMatchObject({id:"recoverable",status:"unknown",step:"move-session"});
  const receipt=await f.service.resume("session","recoverable",stillUnknown.revision);
  expect(receipt.operation).toMatchObject({id:"recoverable",status:"succeeded"});
  expect(await readFile(join(receipt.session.cwd,"tracked.txt"),"utf8")).toBe("queued\n");
},15_000);

test("reconciles its exact captured and already-applied stash after ambiguous phase persistence",async()=>{
  const f=await fixture();
  await writeFile(join(f.repo,"tracked.txt"),"staged\n"); git(f.repo,"add","tracked.txt");
  await writeFile(join(f.repo,"tracked.txt"),"working\n"); await writeFile(join(f.repo,"untracked.txt"),"untracked\n");
  const before=await f.service.get("session"); f.failNextMove();
  await expect(f.service.move("ambiguous-apply","session",before.revision,{kind:"worktree",branch:"feature",localCheckoutBranch:"main"})).rejects.toMatchObject({code:"OUTCOME_UNKNOWN"});
  f.rewindUnknownToCapture();
  const unknown=await f.service.get("session");
  const receipt=await f.service.resume("session","ambiguous-apply",unknown.revision);
  expect(receipt.operation).toMatchObject({status:"succeeded",step:"record-result"});
  expect(await readFile(join(receipt.session.cwd,"tracked.txt"),"utf8")).toBe("working\n");
  expect(await readFile(join(receipt.session.cwd,"untracked.txt"),"utf8")).toBe("untracked\n");
  expect(git(receipt.session.cwd,"diff","--cached","--","tracked.txt")).toContain("+staged");
},15_000);


test("reading task locations does not refresh the shared Git index",async()=>{
  const f=await fixture(), file=join(f.repo,"tracked.txt"), index=join(f.repo,".git","index");
  const before=await readFile(index);
  const metadata=await stat(file);
  await utimes(file,metadata.atime,new Date(metadata.mtimeMs+10_000));
  const snapshot=await f.service.get("session");
  expect(snapshot.current.dirty).toBe(false);
  expect(await readFile(index)).toEqual(before);
});


test("location observation can overlap both moves without blocking Git writes",async()=>{
  const f=await fixture();
  await writeFile(join(f.repo,"tracked.txt"),"working\n");
  const before=await f.service.get("session"); f.observeMoves();
  try {
    const moved=await f.service.move("observed-out","session",before.revision,{kind:"worktree",branch:"feature",localCheckoutBranch:"main"});
    expect(moved.operation.status).toBe("succeeded");
    const current=await f.service.get("session");
    const returned=await f.service.move("observed-back","session",current.revision,{kind:"local",branch:"feature"});
    expect(returned.operation.status).toBe("succeeded");
    expect(await readFile(join(f.repo,"tracked.txt"),"utf8")).toBe("working\n");
  } finally { await f.settleReads(); }
},30_000);
