import type { SessionSummary, TaskLocationAvailability, TaskLocationDestination, TaskLocationMoveReceipt, TaskLocationMoveTarget, TaskLocationOperation, TaskLocationSnapshot } from "@agent-desktop/shared";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, utimes } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import type { WorkerSession } from "./omp-workers/runtime";

const execute = promisify(execFile);
const PREFIX = "task-location.v1:";
const within = (root:string,path:string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const digest = (value:unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

interface PrivateOperation extends TaskLocationOperation {
  target: TaskLocationMoveTarget;
  sourceHead: string;
  sourceBranch: string;
  sourcePrefix: string;
  sourceFence: string;
  destinationFence: string | null;
  mutated: boolean;
  stashAttempted?: boolean;
  stashBefore?: string;
  stashCommit?: string;
  destinationRoot?: string;
  requestRevision: string;
}
interface Store {
  readonly host:{id:string};
  getSession(id:string):SessionSummary|undefined;
  getProject(id:string):import("@agent-desktop/shared").Project|undefined;
  listSessions():SessionSummary[];
  upsertSession(session:SessionSummary):SessionSummary;
  readMetadata<T>(key:string):T|undefined;
  writeMetadata<T>(key:string,value:T):void;
}
interface Dependencies {
  store:Store;
  dataDirectory:string;
  getHandle(id:string):Promise<WorkerSession>;
  publish(event:{type:"task-location";sessionId:string}):void;
  publishState():void;
  reserve(path:string):()=>void;
}

export class TaskLocationError extends Error { constructor(readonly code:string,message:string){super(message);this.name="TaskLocationError";} }
function publicOperation(value:PrivateOperation):TaskLocationOperation {
  const {target:_,sourceHead:__,sourceBranch:___,sourcePrefix:____,sourceFence:_____,destinationFence:______,mutated:_______,stashAttempted:________,stashBefore:_________,stashCommit:__________,destinationRoot:___________,requestRevision:____________,...result}=value;
  return result;
}

export class TaskLocations {
  constructor(private readonly deps:Dependencies) {
    // No task-location command is live while the host is being constructed.
    // Preserve its recorded phase and require explicit reconciliation.
    for (const session of deps.store.listSessions()) {
      const operation=this.latest(session.id);
      if (operation && (operation.status==="queued"||operation.status==="running")) {
        operation.status="unknown";
        operation.message="The host restarted during this task move. Review its recorded destination before resuming the same operation.";
        this.save(operation);
      }
    }
  }
  private async git(cwd:string,args:string[], valid=[0], extraEnv:Record<string,string>={}):Promise<string> {
    try { const result=await execute("git",["-C",cwd,...args],{encoding:"utf8",timeout:30_000,maxBuffer:8*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:"0",GIT_OPTIONAL_LOCKS:"0",LC_ALL:"C",...extraEnv}}); return result.stdout; }
    catch(error){ const e=error as NodeJS.ErrnoException & {code?:number|string;stderr?:string}; if(typeof e.code==="number"&&valid.includes(e.code)) return ""; throw new TaskLocationError("GIT_FAILED",String(e.stderr||e.message).slice(0,4096)); }
  }
  private async matchesAppliedStash(cwd:string,stash:string):Promise<boolean> {
    const expectedIndex=(await this.git(cwd,["rev-parse",`${stash}^2^{tree}`],[0,1])).trim();
    if(!expectedIndex||(await this.git(cwd,["write-tree"])).trim()!==expectedIndex) return false;
    const temporary=await mkdtemp(join(tmpdir(),"agent-desktop-location-index-")), index=join(temporary,"index");
    try {
      const live=(await this.git(cwd,["rev-parse","--path-format=absolute","--git-path","index"])).trim(), metadata=await stat(live); await copyFile(live,index); await utimes(index,metadata.atime,metadata.mtime);
      const env={GIT_INDEX_FILE:index}; await this.git(cwd,["add","-A","--","."],[0],env);
      const tracked=(await this.git(cwd,["ls-tree","-r","-z","--full-tree",`${stash}^{tree}`])).split("\0").filter(Boolean);
      const untracked=(await this.git(cwd,["rev-parse","--verify","-q",`${stash}^3^{tree}`],[0,1])).trim();
      if(untracked) {
        const paths=(await this.git(cwd,["ls-tree","-r","-z","--name-only",untracked])).split("\0").filter(Boolean);
        for(let offset=0;offset<paths.length;offset+=500) await this.git(cwd,["add","-f","--",...paths.slice(offset,offset+500)],[0],env);
      }
      const actual=(await this.git(cwd,["ls-tree","-r","-z","--full-tree",(await this.git(cwd,["write-tree"],[0],env)).trim()])).split("\0").filter(Boolean).sort();
      const expected=[...tracked,...(untracked?(await this.git(cwd,["ls-tree","-r","-z","--full-tree",untracked])).split("\0").filter(Boolean):[])].sort();
      return actual.length===expected.length&&actual.every((row,index)=>row===expected[index]);
    } finally { await rm(temporary,{recursive:true,force:true}); }
  }
  private async rawSelectionFingerprint(cwd:string):Promise<string> {
    const staged=await this.git(cwd,["diff","--cached","--name-only","-z","--no-ext-diff","--no-textconv","--"]);
    const working=await this.git(cwd,["ls-files","-z","-m","-d","-o","--exclude-standard","--","."]);
    const ignored=await this.git(cwd,["ls-files","-z","-o","-i","--exclude-standard","--","."]);
    const paths=[...new Set([...staged.split("\0"),...working.split("\0"),...ignored.split("\0")].filter(Boolean))].sort(), records:Array<[string,string,number?]>=[];
    for(const path of paths) {
      const target=resolve(cwd,path); if(!within(cwd,target)) throw new TaskLocationError("OUTSIDE_WORKSPACE","Git selected a path outside its owning workspace.");
      try {
        const metadata=await lstat(target);
        if(metadata.isSymbolicLink()) records.push([path,`link:${createHash("sha256").update(Buffer.from(await readlink(target))).digest("hex")}`,metadata.mode]);
        else if(metadata.isFile()) records.push([path,`file:${createHash("sha256").update(await readFile(target)).digest("hex")}`,metadata.mode]);
        else throw new TaskLocationError("FILE_UNSUPPORTED","Task movement supports regular files, symlinks, and deletions only.");
      } catch(error) { if((error as NodeJS.ErrnoException).code==="ENOENT") records.push([path,"deleted"]); else throw error; }
    }
    return digest(records);
  }
  private async gitFence(cwd:string):Promise<string> {
    const root=await realpath((await this.git(cwd,["rev-parse","--show-toplevel"])).trim());
    const commonRaw=(await this.git(root,["rev-parse","--path-format=absolute","--git-common-dir"])).trim(), common=await realpath(commonRaw);
    const [rootIdentity,commonIdentity]=await Promise.all([stat(root),stat(common)]);
    const head=(await this.git(root,["rev-parse","--verify","-q","HEAD"],[0,1])).trim();
    const indexState=await this.git(root,["ls-files","--stage","-z"]);
    const status=await this.git(root,["status","--porcelain=v2","-z","--untracked-files=all"]);
    const identity={root,rootDevice:rootIdentity.dev,rootInode:rootIdentity.ino,common,commonDevice:commonIdentity.dev,commonInode:commonIdentity.ino,head,indexState,status};
    if(await this.git(root,["ls-files","--unmerged","-z"])) return digest({...identity,selectedTree:null,rawSelection:null});
    const rawSelection=await this.rawSelectionFingerprint(root);
    const temporary=await mkdtemp(join(tmpdir(),"agent-desktop-location-fence-")), index=join(temporary,"index");
    try {
      const live=(await this.git(root,["rev-parse","--path-format=absolute","--git-path","index"])).trim();
      try { const metadata=await stat(live); await copyFile(live,index); await utimes(index,metadata.atime,metadata.mtime); }
      catch(error) { if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; await this.git(root,["read-tree","--empty"],[0],{GIT_INDEX_FILE:index}); }
      const env={GIT_INDEX_FILE:index}; await this.git(root,["add","-A"],[0],env);
      const selectedTree=(await this.git(root,["write-tree"],[0],env)).trim();
      return digest({...identity,selectedTree,rawSelection});
    } finally { await rm(temporary,{recursive:true,force:true}); }
  }
  private async optionalGitFence(cwd:string):Promise<string|null> {
    try { if(!(await stat(cwd)).isDirectory()) throw new TaskLocationError("TASK_LOCATION_CHANGED","The reviewed destination is no longer a directory."); }
    catch(error) { if((error as NodeJS.ErrnoException).code==="ENOENT") return null; throw error; }
    return this.gitFence(cwd);
  }
  private async assertWorktreeIdentity(sourceRoot:string,destinationRoot:string,managedRoot:string):Promise<void> {
    const actual=await realpath(destinationRoot), managed=await realpath(managedRoot).catch(()=>managedRoot);
    if(!within(managed,actual)) throw new TaskLocationError("WORKTREE_UNAVAILABLE","The destination is outside the host-managed worktree root.");
    const [sourceCommon,destinationCommon]=await Promise.all([this.git(sourceRoot,["rev-parse","--path-format=absolute","--git-common-dir"]),this.git(actual,["rev-parse","--path-format=absolute","--git-common-dir"])]);
    if(await realpath(sourceCommon.trim())!==await realpath(destinationCommon.trim())) throw new TaskLocationError("WORKTREE_UNAVAILABLE","The destination belongs to a different Git repository.");
    const registered=(await this.git(sourceRoot,["worktree","list","--porcelain"])).split("\n").some(row=>row===`worktree ${actual}`);
    if(!registered) throw new TaskLocationError("WORKTREE_UNAVAILABLE","The destination is not a registered managed worktree.");
  }
  private requiredSession(id:string):SessionSummary { const value=this.deps.store.getSession(id); if(!value||value.hostId!==this.deps.store.host.id) throw new TaskLocationError("SESSION_NOT_FOUND","This task is not owned by this host."); return value; }
  private async branch(cwd:string,value:string):Promise<string> {
    if(!value||value.length>200||value.startsWith("-")||value.includes("\0")) throw new TaskLocationError("INVALID_BRANCH","Choose a valid local branch.");
    const checked=(await this.git(cwd,["check-ref-format","--branch",value])).trim();
    if(checked!==value) throw new TaskLocationError("INVALID_BRANCH","Choose a valid local branch.");
    return value;
  }
  private async describe(cwd:string,projectPath:string,managedRoot:string,localLabel?:string):Promise<TaskLocationDestination> {
    const gitRoot=await realpath((await this.git(cwd,["rev-parse","--show-toplevel"])).trim());
    const branch=(await this.git(cwd,["symbolic-ref","--quiet","--short","HEAD"],[0,1])).trim();
    const status=await this.git(cwd,["status","--porcelain=v2","-z","--untracked-files=all"]);
    const kind=gitRoot===projectPath?"local":"worktree";
    return {kind,...(kind==="local"&&localLabel?{label:localLabel}:{}),cwd:await realpath(cwd),gitRoot,branch,managed:kind==="worktree"&&within(managedRoot,gitRoot),dirty:Boolean(status),conflicted:status.split("\0").some(row=>row.startsWith("u "))};
  }
  private async eligibleLocalCheckoutBranches(cwd:string,currentBranch:string):Promise<string[]> {
    const branches=(await this.git(cwd,["for-each-ref","--format=%(refname:short)","refs/heads"])).trim().split("\n").filter(Boolean);
    const worktrees=(await this.git(cwd,["worktree","list","--porcelain"])).split("\n"), checkedOut=new Set<string>();
    for(const row of worktrees) if(row.startsWith("branch refs/heads/")) checkedOut.add(row.slice("branch refs/heads/".length));
    return branches.filter(branch=>branch!==currentBranch&&!checkedOut.has(branch)).sort((a,b)=>a.localeCompare(b));
  }
  private latest(sessionId:string):PrivateOperation|undefined { return this.deps.store.readMetadata(`${PREFIX}${sessionId}`); }
  requiresRecovery(sessionId:string):boolean { const value=this.latest(sessionId); return Boolean(value && value.status!=="succeeded" && value.status!=="failed"); }
  private save(value:PrivateOperation):void { value.revision++; this.deps.store.writeMetadata(`${PREFIX}${value.sessionId}`,value); this.deps.publish({type:"task-location",sessionId:value.sessionId}); }
  private async inspect(sessionId:string):Promise<{snapshot:TaskLocationSnapshot;sourceFence:string;destinationFence:string|null}> {
    const session=this.requiredSession(sessionId), project=session.projectId&&this.deps.store.getProject(session.projectId);
    if(!project||project.hostId!==session.hostId) throw new TaskLocationError("PROJECT_REQUIRED","Moving an existing task requires its retained local project.");
    const projectPath=await realpath(project.path), managedPath=resolve(this.deps.dataDirectory,"worktrees",project.id), managedRoot=await realpath(managedPath).catch(()=>managedPath);
    const current=await this.describe(session.cwd,projectPath,managedRoot,project.name);
    const operation=this.latest(sessionId);
    let local:TaskLocationAvailability, worktree:TaskLocationAvailability, localCheckoutBranches:string[]=[];
    if(current.kind==="local") {
      local={available:false,reason:"This task is already in the local checkout.",destination:current};
      const branch=current.branch;
      localCheckoutBranches=branch?await this.eligibleLocalCheckoutBranches(current.gitRoot,branch):[];
      worktree=branch&&!current.conflicted&&localCheckoutBranches.length?{available:true,destination:{kind:"worktree",cwd:join(managedRoot,`task-${session.id}`),gitRoot:join(managedRoot,`task-${session.id}`),branch,managed:true,dirty:false,conflicted:false}}:{available:false,reason:current.conflicted?"Resolve Git conflicts before moving this task.":!branch?"Attach the local checkout to a branch before moving it.":"Create or free another local branch for the checkout before moving this task."};
    } else {
      worktree={available:false,reason:"This task is already in a managed worktree.",destination:current};
      const clean=await this.describe(projectPath,projectPath,managedRoot,project.name);
      local=current.managed&&!clean.dirty&&!clean.conflicted&&Boolean(current.branch)?{available:true,destination:{...clean,branch:current.branch}}:{available:false,reason:!current.managed?"This task is outside the host-managed worktree root.":clean.conflicted||clean.dirty?"Clean the local checkout before bringing this task back.":"Attach the worktree to a branch before bringing it back."};
    }
    const base={version:1 as const,sessionId,hostId:session.hostId,current,local,worktree,localCheckoutBranches,...(operation?{operation:publicOperation(operation)}:{})};
    const sourceFence=await this.gitFence(current.gitRoot), alternate=current.kind==="local"?worktree.destination:local.destination;
    const destinationFence=alternate?await this.optionalGitFence(alternate.gitRoot):null;
    return {snapshot:{...base,revision:digest({...base,sourceFence,destinationFence})},sourceFence,destinationFence};
  }
  async get(sessionId:string):Promise<TaskLocationSnapshot> { return (await this.inspect(sessionId)).snapshot; }
  async move(commandId:string,sessionId:string,expectedRevision:string,target:TaskLocationMoveTarget):Promise<TaskLocationMoveReceipt>{
    {
      const prior=this.latest(sessionId); if(prior&&(prior.status==="queued"||prior.status==="running"||prior.status==="unknown")) throw new TaskLocationError("OPERATION_REQUIRES_RECOVERY","Recover the existing task location operation before starting another move.");
      const priorIdentity=prior?`${prior.id}:${prior.revision}`:null;
      const inspected=await this.inspect(sessionId), snapshot=inspected.snapshot; if(snapshot.revision!==expectedRevision) throw new TaskLocationError("TASK_LOCATION_CHANGED","Task location changed. Refresh before moving it.");
      if(target.kind==="local") await this.branch(snapshot.current.gitRoot,target.branch); else {
        await this.branch(snapshot.current.gitRoot,target.branch); await this.branch(snapshot.current.gitRoot,target.localCheckoutBranch);
        if(!snapshot.localCheckoutBranches.includes(target.localCheckoutBranch)) throw new TaskLocationError("TASK_LOCATION_UNAVAILABLE","Choose an available host-reported branch for the local checkout.");
      }
      const availability=target.kind==="local"?snapshot.local:snapshot.worktree;
      if(!availability.available||!availability.destination) throw new TaskLocationError("TASK_LOCATION_UNAVAILABLE",availability.reason||"That destination is unavailable.");
      const current=snapshot.current;
      if(target.kind==="worktree"&&target.branch!==current.branch) throw new TaskLocationError("BRANCH_CHANGED","Refresh the current branch before moving this task.");
      const head=(await this.git(current.gitRoot,["rev-parse","HEAD"])).trim();
      const admitted=this.latest(sessionId),admittedIdentity=admitted?`${admitted.id}:${admitted.revision}`:null;
      if(admittedIdentity!==priorIdentity) throw new TaskLocationError("TASK_LOCATION_CHANGED","Another task location operation was admitted while this request was being reviewed. Refresh before moving it.");
      const op:PrivateOperation={id:commandId,revision:0,sessionId,hostId:snapshot.hostId,direction:target.kind==="local"?"to-local":"to-worktree",status:"queued",step:"validate",source:current,destination:availability.destination,warnings:[],target,sourceHead:head,sourceBranch:current.branch,sourcePrefix:relative(current.gitRoot,current.cwd),sourceFence:inspected.sourceFence,destinationFence:inspected.destinationFence,mutated:false,requestRevision:expectedRevision};
      this.save(op); return this.run(op);
    }
  }
  async resume(sessionId:string,operationId:string,expectedRevision:string):Promise<TaskLocationMoveReceipt>{
    const snapshot=await this.get(sessionId),op=this.latest(sessionId); if(snapshot.revision!==expectedRevision) throw new TaskLocationError("TASK_LOCATION_CHANGED","Task location changed. Refresh recovery first."); if(!op||op.id!==operationId) throw new TaskLocationError("OPERATION_NOT_FOUND","The task location operation is unavailable."); if(op.status!=="failed"&&op.status!=="unknown") throw new TaskLocationError("OPERATION_NOT_RECOVERABLE","This task location operation is not awaiting recovery."); return this.run(op);
  }
  private async captureChanges(op:PrivateOperation):Promise<void> {
    if(op.step==="validate") {
      op.step="capture-changes";
      op.stashBefore=(await this.git(op.source.gitRoot,["rev-parse","--verify","-q","refs/stash"],[0,1])).trim();
      this.save(op);
    }
    const current=(await this.git(op.source.gitRoot,["rev-parse","--verify","-q","refs/stash"],[0,1])).trim();
    if(current&&current!==op.stashBefore) {
      const message=await this.git(op.source.gitRoot,["log","-1","--format=%B",current]);
      if(!message.includes(`agent-desktop-location:${op.id}`)) throw new TaskLocationError("OUTCOME_UNKNOWN","The stash changed during task-location recovery and cannot be attributed to the original operation.");
      op.stashCommit=current; op.mutated=true;
    }
    else {
      if(op.stashAttempted && await this.gitFence(op.source.gitRoot)!==op.sourceFence) throw new TaskLocationError("OUTCOME_UNKNOWN","The first stash attempt may have changed working files without leaving an attributable recovery stash. Inspect this checkout before resuming.");
      op.stashAttempted=true; op.mutated=true; this.save(op);
      await this.git(op.source.gitRoot,["stash","push","--all","--message",`agent-desktop-location:${op.id}`]);
      const after=(await this.git(op.source.gitRoot,["rev-parse","--verify","-q","refs/stash"],[0,1])).trim();
      if(after&&after!==op.stashBefore) op.stashCommit=after;
    }
    op.step="prepare-destination"; this.save(op);
  }
  private async prepareDestination(op:PrivateOperation):Promise<void> {
    const destination=op.destination!;
    if(op.stashCommit && await this.matchesAppliedStash(destination.gitRoot,op.stashCommit).catch(()=>false)) {
      op.step="switch-git"; op.destinationRoot=destination.gitRoot; this.save(op); return;
    }
    if(op.direction==="to-worktree") {
      if(op.target.kind!=="worktree"||op.target.localCheckoutBranch===op.sourceBranch) throw new TaskLocationError("LOCAL_BRANCH_REQUIRED","Choose a different branch for the local checkout.");
      await this.git(op.source.gitRoot,["show-ref","--verify","--quiet",`refs/heads/${op.target.localCheckoutBranch}`]);
      await this.git(op.source.gitRoot,["checkout",op.target.localCheckoutBranch]); op.mutated=true;
      await mkdir(dirname(destination.gitRoot),{recursive:true});
      let exists=false; try { exists=(await stat(destination.gitRoot)).isDirectory(); } catch(error){ if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
      if(exists) {
        const registered=(await this.git(op.source.gitRoot,["worktree","list","--porcelain"])).split("\n").some(row=>row===`worktree ${destination.gitRoot}`);
        if(!registered||await this.git(destination.gitRoot,["status","--porcelain=v1","-z","--untracked-files=all"])) throw new TaskLocationError("WORKTREE_UNAVAILABLE","The prior managed worktree is missing from Git or has changes of its own.");
        await this.git(destination.gitRoot,["checkout","--detach",op.sourceHead]);
      } else await this.git(op.source.gitRoot,["worktree","add","--detach",destination.gitRoot,op.sourceHead]);
      await this.assertWorktreeIdentity(op.source.gitRoot,destination.gitRoot,resolve(this.deps.dataDirectory,"worktrees",this.requiredSession(op.sessionId).projectId!));
      await this.git(destination.gitRoot,["checkout",op.target.branch]);
    } else {
      if(op.target.kind!=="local") throw new TaskLocationError("INVALID_TARGET","Invalid local destination.");
      await this.git(op.source.gitRoot,["checkout","--detach",op.sourceHead]); op.mutated=true;
      const tip=(await this.git(destination.gitRoot,["rev-parse","--verify","-q",`refs/heads/${op.target.branch}`],[0,1])).trim();
      if(tip&&tip!==op.sourceHead) throw new TaskLocationError("DESTINATION_BRANCH_CHANGED","The destination branch moved away from this task's reviewed HEAD. Review it before moving.");
      if(!tip) await this.git(destination.gitRoot,["branch",op.target.branch,op.sourceHead]);
      await this.git(destination.gitRoot,["checkout",op.target.branch]);
    }
    if(op.stashCommit) await this.git(destination.gitRoot,["stash","apply","--index",op.stashCommit]);
    op.step="switch-git"; op.destinationRoot=destination.gitRoot; this.save(op);
  }
  private async moveNativeSession(op:PrivateOperation,handle:WorkerSession):Promise<TaskLocationMoveReceipt> {
    const destination=op.destination!; op.step="move-session"; this.save(op);
    const targetCwd=join(destination.gitRoot,op.sourcePrefix), moved=await handle.moveSession(targetCwd); op.mutated=true;
    if(moved.id!==op.sessionId||(await realpath(moved.cwd))!==(await realpath(targetCwd))) throw new TaskLocationError("OUTCOME_UNKNOWN","Native task movement could not be verified.");
    const current=this.requiredSession(op.sessionId), saved=this.deps.store.upsertSession({...current,cwd:await realpath(targetCwd),sessionFile:moved.sessionFile,updatedAt:Date.now()});
    if(op.stashCommit) await this.dropStash(destination.gitRoot,op.stashCommit).catch(()=>op.warnings.push("The transferred changes are safe, but their recovery stash remains and may be removed manually."));
    op.step="record-result"; op.status="succeeded"; op.destination={...destination,cwd:saved.cwd,dirty:Boolean(await this.git(destination.gitRoot,["status","--porcelain=v1","-z","--untracked-files=all"])),conflicted:false}; this.save(op); this.deps.publishState();
    return {type:"session.location.move",operation:publicOperation(op),session:saved};
  }
  private async run(op:PrivateOperation):Promise<TaskLocationMoveReceipt>{
    const releases:(()=>void)[]=[], uncertainBefore=op.status==="unknown"||op.mutated;
    try {
      const session=this.requiredSession(op.sessionId); if(session.status!=="idle"&&session.status!=="error"&&session.status!=="interrupted") throw new TaskLocationError("SESSION_BUSY","Wait for the task to become idle before moving it.");
      const handle=await this.deps.getHandle(op.sessionId);
      releases.push(this.deps.reserve(op.source.gitRoot));
      if(op.destination?.gitRoot!==op.source.gitRoot) releases.push(this.deps.reserve(op.destination!.gitRoot));
      if(op.step==="validate"&&((await realpath(session.cwd))!==op.source.cwd||(await this.gitFence(op.source.gitRoot))!==op.sourceFence||(await this.optionalGitFence(op.destination!.gitRoot))!==op.destinationFence)) throw new TaskLocationError("TASK_LOCATION_CHANGED","The reviewed branch, HEAD, index, selected files, or destination changed before the task move started.");
      op.status="running"; this.save(op);
      if(handle.isStreaming||handle.hasPostPromptWork) throw new TaskLocationError("SESSION_BUSY","Wait for native task work to finish before moving it.");
      await handle.assertTaskLocationReady();
      if(op.step==="validate"&&((await realpath(session.cwd))!==op.source.cwd||(await this.gitFence(op.source.gitRoot))!==op.sourceFence||(await this.optionalGitFence(op.destination!.gitRoot))!==op.destinationFence)) throw new TaskLocationError("TASK_LOCATION_CHANGED","The reviewed branch, HEAD, index, selected files, or destination changed while native readiness was checked.");
      for(;;) switch(op.step) {
        case "validate": case "capture-changes": await this.captureChanges(op); continue;
        case "prepare-destination": await this.prepareDestination(op); continue;
        case "switch-git": case "move-session": return await this.moveNativeSession(op,handle);
        default: throw new TaskLocationError("OUTCOME_UNKNOWN","The task location operation is in an unsupported recovery phase.");
      }
    } catch(error) {
      op.status=uncertainBefore||op.mutated||error instanceof Error&&"code" in error&&(error as {code?:string}).code==="OUTCOME_UNKNOWN"?"unknown":"failed";
      op.message=error instanceof Error?error.message:"Task movement failed"; this.save(op);
      if (op.status==="unknown" && !(error instanceof Error && "code" in error && (error as {code?:string}).code==="OUTCOME_UNKNOWN")) {
        const uncertain=new TaskLocationError("OUTCOME_UNKNOWN",`The task move changed Git state but did not reach a verified result. Resume this exact operation after inspection. ${op.message}`);
        throw uncertain;
      }
      throw error;
    } finally { for(const release of releases.reverse()) release(); }
  }
  private async dropStash(cwd:string,commit:string):Promise<void>{
    const rows=(await this.git(cwd,["reflog","show","--format=%H","refs/stash"],[0,1])).trim().split("\n"); const index=rows.indexOf(commit); if(index>=0) await this.git(cwd,["stash","drop",`stash@{${index}}`]);
  }
}
