import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {WindowCloseGate,type WindowCloseRequest} from "./window-close";
import {ModifierReleaseWatches} from "./modifier-release";
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,0));

// Actual main registration + gate configuration, controlled Electron event shapes.
// This does not load Electron, launch helpers or claim its native event ordering.
test("main quit registration recovers watch service after renderer loss during helper drain",async()=>{
 const main=readFileSync(process.env.AGENT_DESKTOP_QUIT_MAIN_SOURCE ?? new URL("./main.ts",import.meta.url),"utf8");
 const start=main.indexOf('const windowCloseGate = new WindowCloseGate({'),end=main.indexOf('const windowStates =',start);
 const before=main.indexOf('app.on("before-quit", event => {'),after=main.indexOf('app.on("will-quit"',before);
 if(start<0||end<0||before<0||after<0) throw Error("Quit source boundaries changed; update the fixture explicitly.");
 const flags=main.match(/^let modifierQuitReady = false, modifierQuitPending = false;$/m)?.[0] ?? "";
 const registration=main.slice(before,after),configuration=main.slice(start,end);
 const sent:{senderId:number;request:WindowCloseRequest}[]=[];
 const windows=new Set([1,2].map(id=>({isDestroyed:()=>false,webContents:{id,isDestroyed:()=>false,send:(_channel:string,request:WindowCloseRequest)=>sent.push({senderId:id,request})}})));
 let beforeQuit:(event:{preventDefault():void})=>void=()=>{throw Error("No handler");};
 let gate!:WindowCloseGate,launches=0,finish!:()=>void,firstSignal!:AbortSignal,blockedQuits=0;
 const watches=new ModifierReleaseWatches(async(_modifier,signal)=>{
  launches++;if(launches>1)return "released";
  firstSignal=signal;await new Promise<void>(resolve=>{finish=resolve;});return "cancelled";
 });
 const app={on:(name:string,callback:typeof beforeQuit)=>{if(name!=="before-quit")throw Error("Unexpected registration");beforeQuit=callback;},quit:()=>{
   let prevented=false;beforeQuit({preventDefault:()=>{prevented=true;}});
   if(!prevented) for(const window of windows) if(!gate.handleWindowClose(window.webContents.id,()=>{})) blockedQuits++;
 }};
 const install=new Function("app","WindowCloseGate","modifierWatches","windows","dialog",`${flags}\n${configuration}\n${registration}\nreturn windowCloseGate;`) as (...args:unknown[])=>WindowCloseGate;
 gate=install(app,WindowCloseGate,watches,windows,{showMessageBox:async()=>({response:0})});gate.register(1);gate.register(2);
 const watch=watches.watch(1,"initial","meta");await tick();
 try {
  app.quit();for(const {senderId,request} of [...sent]) gate.answer(senderId,request.id,true);await tick();
  expect(firstSignal.aborted).toBe(true);expect(launches).toBe(1);
  gate.destroy(1);finish();await watch;await tick();gate.register(1);
  expect(await watches.watch(1,"recovered","meta")).toBe("released");expect(launches).toBe(2);
  expect(blockedQuits).toBe(0);expect(gate.consumeQuitPermit()).toBe(false);
 } finally {finish();for(const window of windows) gate.destroy(window.webContents.id);await watches.dispose();}
});
