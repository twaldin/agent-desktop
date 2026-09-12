import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModifierReleaseWatches, resolveModifierMonitor, watchNativeModifier } from "./modifier-release";
import type { ModifierReleaseResult } from "@agent-desktop/shared";

function child() {
  const process = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), signals: [] as string[],
    kill(signal: string) { this.signals.push(signal); return true; },
  });
  const launch = ((path: string, args: string[]) => {
    expect(path).toBe("/owned/native/modifier-release"); expect(args).toEqual(["meta"]);
    return process;
  }) as unknown as NonNullable<Parameters<typeof watchNativeModifier>[3]>;
  return { process, launch };
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

test("response alone is not success: require exact up plus clean close", async () => {
  for (const [response, code, expected] of [["up\n", 0, "released"], ["up\n", 1, "unavailable"],
    ["", 0, "unavailable"], ["unavailable\n", 0, "unavailable"], ["up\nup\n", 0, "unavailable"]] as const) {
    const f = child(), abort = new AbortController();
    let settled = false;
    const result = watchNativeModifier("/owned/native/modifier-release", "meta", abort.signal, f.launch).then(value => { settled = true; return value; });
    f.process.stdout.write(response); await tick(); expect(settled).toBe(false);
    f.process.emit("close", code); expect(await result).toBe(expected);
    expect(f.process.listenerCount("close")).toBe(0); expect(f.process.stdout.listenerCount("data")).toBe(0);
  }
});
test("cancel, timeout and oversized/error output kill and wait for reaping", async () => {
  for (const kind of ["cancel", "timeout", "oversize", "error"] as const) {
    const f = child(), abort = new AbortController(); let settled = false;
    const result = watchNativeModifier("/owned/native/modifier-release", "meta", abort.signal, f.launch, {watchMs:kind === "timeout" ? 1 : 1000,killMs:1}).then(value => {settled=true;return value;});
    if(kind === "cancel") abort.abort();
    if(kind === "oversize") f.process.stdout.write("x".repeat(65));
    if(kind === "error") f.process.emit("error",new Error("failed"));
    await new Promise(resolve=>setTimeout(resolve,15));
    expect(f.process.signals).toEqual(["SIGTERM","SIGKILL"]);expect(settled).toBe(false);
    f.process.emit("close",null);expect(await result).toBe(kind === "cancel" ? "cancelled" : "unavailable");
  }
});
test("pre-abort and spawn failure never report physical release", async () => {
  const abort=new AbortController();abort.abort();let calls=0;
  const launch=(()=>{calls++;throw Error("missing");}) as NonNullable<Parameters<typeof watchNativeModifier>[3]>;
  expect(await watchNativeModifier("/owned/native/modifier-release","meta",abort.signal,launch)).toBe("cancelled");expect(calls).toBe(0);
  expect(await watchNativeModifier("/owned/native/modifier-release","meta",new AbortController().signal,launch)).toBe("unavailable");expect(calls).toBe(1);
});

test("owner supersession waits for prior exit, stale cancel is fenced, windows stay independent", async () => {
  const calls: {modifier:string;signal:AbortSignal;finish:(result:ModifierReleaseResult)=>void}[]=[];
  const watches=new ModifierReleaseWatches((modifier,signal)=>new Promise(finish=>calls.push({modifier,signal,finish})));
  const first=watches.watch(1,"one","meta");await tick();
  const second=watches.watch(1,"two","control");expect(calls[0]!.signal.aborted).toBe(true);
  watches.cancel(1,"one");await tick();expect(calls.length).toBe(1);
  const other=watches.watch(2,"one","meta");await tick();expect(calls.length).toBe(2);expect(calls[1]!.signal.aborted).toBe(false);
  calls[0]!.finish("cancelled");expect(await first).toBe("cancelled");await tick();expect(calls.length).toBe(3);expect(calls[2]!.signal.aborted).toBe(false);
  expect(watches.watch(1,"two","control")).toBe(second);
  const done=watches.dispose();expect(calls[1]!.signal.aborted).toBe(true);expect(calls[2]!.signal.aborted).toBe(true);
  calls[1]!.finish("cancelled");calls[2]!.finish("cancelled");await Promise.all([done,second,other]);
  expect(await watches.watch(3,"three","meta")).toBe("unavailable");expect(calls.length).toBe(3);
});
test("cancel while queued prevents spawning; invalid inputs never launch", async () => {
  let calls=0;
  const watches=new ModifierReleaseWatches(async()=>{calls++;return "released";});
  const pending=watches.watch(1,"queued","meta");watches.cancel(1);expect(await pending).toBe("cancelled");expect(calls).toBe(0);
  await expect(watches.watch(1,"bad id","meta")).rejects.toThrow();await expect(watches.watch(1,"ok","shift")).rejects.toThrow();expect(calls).toBe(0);
});
test("owned helper lookup rejects absent, nonexecutable and escaping helpers with no PATH fallback",()=>{
  const root=mkdtempSync(join(tmpdir(),"modifier-path-"));
  try {
    const owner=join(root,"app"),native=join(owner,"native"),path=join(native,"modifier-release");mkdirSync(native,{recursive:true});
    expect(()=>resolveModifierMonitor(owner)).toThrow();expect(()=>resolveModifierMonitor("relative")).toThrow();
    writeFileSync(path,"fixture",{mode:0o600});expect(()=>resolveModifierMonitor(owner)).toThrow();rmSync(path);
    const outside=join(root,"outside");writeFileSync(outside,"fixture",{mode:0o700});symlinkSync(outside,path);expect(()=>resolveModifierMonitor(owner)).toThrow();rmSync(path);
    writeFileSync(path,"fixture",{mode:0o700});expect(resolveModifierMonitor(owner)).toBe(realpathSync(path));
  } finally {rmSync(root,{recursive:true,force:true});}
});
