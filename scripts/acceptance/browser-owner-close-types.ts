/** Check the actual public close declarations and consumer with library checking enabled.
 * Dependency declarations resolve normally; this checks these selected files, not the full SDK graph. */
import path from "node:path";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";

const directory = process.argv[2];
if (!directory) throw new Error("Pass the exact candidate dist/types directory.");
const root = realpathSync(directory);
const declarations = [path.join(root,"tools/browser/tab-supervisor.d.ts"),path.join(root,"tools/browser.d.ts")];
const output = process.argv[3]; if (!output) throw new Error("Pass a NEW diagnostics output directory.");
const outputRoot = path.resolve(output); mkdirSync(outputRoot);
const filename = path.join(outputRoot,"consumer.ts");
const consumer = `
import { BROWSER_TAB_OWNER_CLOSE_VERSION, releaseTabForOwner } from "selected-browser";
import type { OwnerTabViewportTarget } from "selected-supervisor";
const version: 1 = BROWSER_TAB_OWNER_CLOSE_VERSION;
const target: OwnerTabViewportTarget = { name: "original", targetId: "original-target" };
const result = releaseTabForOwner("original-owner", target, {timeoutMs:5000,signal:new AbortController().signal});
const exact: Promise<Readonly<{ownerSessionId:string;name:string;targetId:string;released:true}>> = result;
type IsAny<T> = 0 extends (1 & T) ? true : false;
const targetIsNotAny: IsAny<OwnerTabViewportTarget> = false;
const resultIsNotAny: IsAny<Awaited<typeof result>> = false;
// @ts-expect-error The published original target is readonly.
target.name = "replacement";
// @ts-expect-error The published original native identity is readonly.
target.targetId = "replacement";
// @ts-expect-error A name alone cannot identify an original target.
releaseTabForOwner("owner", {name:"original"});
// @ts-expect-error Native target identity must be a string.
releaseTabForOwner("owner", {name:"original",targetId:123});
// @ts-expect-error Close requires a creator identity.
releaseTabForOwner(123, target);
// @ts-expect-error Close does not accept a backend-changing option.
releaseTabForOwner("owner", target, {kill:true});
async function checkResult() {
 const value = await result;
 // @ts-expect-error Only released:true is a successful close result.
 const unreleased: false = value.released;
 // @ts-expect-error The returned confirmation is readonly.
 value.targetId = "replacement";
}
void version; void exact; void targetIsNotAny; void resultIsNotAny; void checkResult;
`;
const installedTypes = realpathSync("node_modules/@oh-my-pi/pi-coding-agent/dist/types");
const configPath = path.join(outputRoot,"tsconfig.json");
const config = JSON.stringify({compilerOptions:{
  strict:true, noEmit:true, skipLibCheck:false,
  target:"ESNext", module:"ESNext", moduleResolution:"Bundler",
  lib:["ES2023","DOM"], types:[], rootDirs:[root,installedTypes],
  paths:{"selected-browser":[declarations[1]],"selected-supervisor":[declarations[0]]},
},files:[filename]});
writeFileSync(filename,consumer);writeFileSync(configPath,config);
const command = [path.resolve("node_modules/.bin/tsc"),"-p",configPath,"--pretty","false"];
const result = Bun.spawnSync(command,{stdout:"pipe",stderr:"pipe"});
const raw = new TextDecoder().decode(result.stdout)+new TextDecoder().decode(result.stderr);
writeFileSync(path.join(outputRoot,"compiler.log"),raw);
const selected = new Set([...declarations,filename]);
const diagnostics:Array<{file?:string;code:number;text:string;selected:boolean}> = [];
for (const line of raw.split(/\r?\n/)) {
  const match = /^(.*)\(\d+,\d+\): error TS(\d+): (.*)$/.exec(line);
  const global = /^error TS(\d+): (.*)$/.exec(line);
  if (match) {
    const file = path.resolve(match[1]!);
    diagnostics.push({file,code:Number(match[2]),text:match[3]!,selected:selected.has(file)});
  } else if (global) diagnostics.push({code:Number(global[1]),text:global[2]!,selected:true});
}
if (result.signalCode || result.exitCode !== 0 && !diagnostics.length) throw new Error("Compiler failed without recognized diagnostics: "+raw);
const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const report = {command,compilerExitCode:result.exitCode,checked:declarations.map(file=>({path:file,sha256:sha(readFileSync(file,"utf8"))})),
  consumerSha256:sha(consumer),configSha256:sha(config),skipLibCheck:false,
  diagnostics,selectedFailures:diagnostics.filter(item=>item.selected).length,
  limit:"Actual public declarations and positive/negative consumer diagnostics only. Full compiler log and out-of-scope dependency diagnostics retained; compiler exit is not claimed as full SDK graph success. Compiler command only, no SDK import, emitted consumer, native operation or app runtime."};
writeFileSync(path.join(outputRoot,"result.json"),JSON.stringify(report,null,2)+"\n");
console.log(JSON.stringify(report,null,2));
if (report.selectedFailures) process.exitCode=1;
