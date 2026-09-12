import {afterEach,describe,expect,test} from "bun:test";
import {mkdir,mkdtemp,readFile,readdir,rename,rm,symlink,utimes,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkspaceService} from "../workspace";

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))});
async function fixture(){const root=await mkdtemp(join(tmpdir(),"workspace-file-operations-"));roots.push(root);const cwd=join(root,"workspace");await mkdir(cwd);return{root,cwd,service:new WorkspaceService(cwd)}}

describe("reviewed workspace path operations",()=>{
 test("creates files and folders without replacing an existing path",async()=>{
  const f=await fixture();
  expect((await f.service.createFile("new.txt")).entry).toMatchObject({path:"new.txt",kind:"file"});
  expect((await f.service.createDirectory("folder")).entry).toMatchObject({path:"folder",kind:"directory"});
  await expect(f.service.createFile("new.txt")).rejects.toMatchObject({code:"ALREADY_EXISTS"});
  await expect(f.service.createDirectory("folder")).rejects.toMatchObject({code:"ALREADY_EXISTS"});
  expect((await readdir(f.cwd)).sort()).toEqual(["folder","new.txt"]);
 });

 test("renames only the reviewed identity and never replaces a destination",async()=>{
  const f=await fixture();await writeFile(join(f.cwd,"source.txt"),"one");await writeFile(join(f.cwd,"occupied.txt"),"keep");
  const reviewed=await f.service.pathContext("source.txt");
  await expect(f.service.renamePath("source.txt","occupied.txt",reviewed.revision)).rejects.toMatchObject({code:"ALREADY_EXISTS"});
  await writeFile(join(f.cwd,"source.txt"),"changed");
  await expect(f.service.renamePath("source.txt","moved.txt",reviewed.revision)).rejects.toMatchObject({code:"REVISION_CONFLICT"});
  const current=await f.service.pathContext("source.txt"), moved=await f.service.renamePath("source.txt","nested/moved.txt",current.revision).catch(error=>error);
  expect(moved).toMatchObject({code:"ENOENT"});
  await mkdir(join(f.cwd,"nested"));
  expect((await f.service.renamePath("source.txt","nested/moved.txt",current.revision)).entry.path).toBe("nested/moved.txt");
  expect(await readFile(join(f.cwd,"nested/moved.txt"),"utf8")).toBe("changed");
  expect(await readFile(join(f.cwd,"occupied.txt"),"utf8")).toBe("keep");
 });

 test("deletes a reviewed file, link, or empty folder and refuses recursive deletion",async()=>{
  const f=await fixture();await writeFile(join(f.cwd,"file.txt"),"contents");await mkdir(join(f.cwd,"empty"));await mkdir(join(f.cwd,"full"));await writeFile(join(f.cwd,"full/child"),"keep");await symlink("file.txt",join(f.cwd,"link"));
  for(const path of ["link","file.txt","empty"]){const reviewed=await f.service.pathContext(path);await f.service.deletePath(path,reviewed.revision)}
  const full=await f.service.pathContext("full");await expect(f.service.deletePath("full",full.revision)).rejects.toMatchObject({code:"DIRECTORY_NOT_EMPTY"});
  expect(await readFile(join(f.cwd,"full/child"),"utf8")).toBe("keep");
  await expect(f.service.pathContext(".")).rejects.toMatchObject({code:"WORKSPACE_ROOT"});
 });

 test("same-size restored-mtime changes cannot pass the reviewed path revision",async()=>{
  const f=await fixture(),file=join(f.cwd,"same.txt"),epoch=new Date(1_700_000_000_000);await writeFile(file,"AAAA");await utimes(file,epoch,epoch);
  const reviewed=await f.service.pathContext("same.txt");await writeFile(file,"BBBB");await utimes(file,epoch,epoch);
  await expect(f.service.deletePath("same.txt",reviewed.revision)).rejects.toMatchObject({code:"REVISION_CONFLICT"});
  expect(await readFile(file,"utf8")).toBe("BBBB");
 });

 test("workspace replacement and outside traversal are rejected",async()=>{
  const f=await fixture();await writeFile(join(f.cwd,"owned"),"inside");const reviewed=await f.service.pathContext("owned");
  await rename(f.cwd,join(f.root,"old"));await mkdir(f.cwd);await writeFile(join(f.cwd,"owned"),"replacement");
  await expect(f.service.deletePath("owned",reviewed.revision)).rejects.toMatchObject({code:"PATH_CHANGED"});
  const current=new WorkspaceService(f.cwd);
  await expect(current.createFile("../outside")).rejects.toMatchObject({code:"OUTSIDE_WORKSPACE"});
 });
});
