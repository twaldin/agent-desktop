import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalManager } from "./manager";

test("an isolated host without SHELL starts its default real terminal without changing its environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-default-shell-"));
  const managerPath = new URL("./manager.ts", import.meta.url).pathname;
  const selectorPath = new URL("./default-shell.ts", import.meta.url).pathname;
  const source = `import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {userInfo} from 'node:os';
import {isAbsolute} from 'node:path';
import {TerminalManager} from ${JSON.stringify(managerPath)};
import {defaultTerminalShell} from ${JSON.stringify(selectorPath)};
assert.equal(process.env.SHELL,undefined);
let loginShell;try{loginShell=userInfo().shell}catch{}
const expectedShell=typeof loginShell==='string'&&isAbsolute(loginShell)&&!loginShell.includes(String.fromCharCode(0))?loginShell:process.platform==='darwin'?'/bin/zsh':'/bin/sh';
assert.equal(defaultTerminalShell().application,expectedShell);
const manager=new TerminalManager();
try {const terminal=await manager.create({cwd:process.env.FIXTURE_DIRECTORY,target:{projectId:crypto.randomUUID()},cols:80,rows:24});
manager.write(terminal.id,'printf DEFAULT_SHELL_READY > default-shell-result.txt'+String.fromCharCode(13));
const end=Date.now()+5000;while(!existsSync('default-shell-result.txt')){if(Date.now()>end)throw new Error('Default terminal did not accept input');await Bun.sleep(10)}
assert.equal(readFileSync('default-shell-result.txt','utf8'),'DEFAULT_SHELL_READY');
assert.equal(process.env.SHELL,undefined);console.log('isolated default terminal passed');}
finally {await manager.shutdown();}`;
  const child = Bun.spawn([process.execPath, "-e", source], { cwd: directory, env: { HOME: directory, ZDOTDIR: directory, HISTFILE: "/dev/null", ENV: "/dev/null", BASH_ENV: "/dev/null", PATH: process.env.PATH, TMPDIR: tmpdir(), FIXTURE_DIRECTORY: directory }, stdout: "pipe", stderr: "pipe" });
  const output = new Response(child.stdout).text(), error = new Response(child.stderr).text();
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try { const code = await child.exited; if (code) throw new Error(await error); expect(await output).toContain("isolated default terminal passed"); }
  finally { clearTimeout(timer); if (child.exitCode === null) { child.kill(); await child.exited; } await rm(directory, { recursive: true, force: true }); }
}, 15_000);

test("malformed explicit shell settings still fail instead of selecting a fallback", () => {
  for (const shell of [{ application: "unknown", args: [] }, { application: "relative/sh", args: [] }, { application: "/bin/sh\0ignored", args: [] }, { application: "/bin/sh", args: ["-i\0ignored"] }]) {
    let error: unknown;
    try { new TerminalManager({ shell }); } catch (cause) { error = cause; }
    expect(error).toMatchObject({ code: "INVALID_SHELL" });
  }
});
