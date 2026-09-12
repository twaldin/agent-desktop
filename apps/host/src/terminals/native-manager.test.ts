import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { Terminal } from "@xterm/xterm";
import { TmuxTerminalManager } from "./native-manager";
import { TmuxControl } from "./control";
import { assertNoNativeTerminalOwnership } from "../../../../scripts/terminal-upgrade-guard";
import type { NativeTerminalAttachment, NativeTerminalInput } from "../../../../packages/shared/src/terminals";

const bundle = process.env.AGENT_TEST_TMUX_BUNDLE;
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const fixtures: { directory: string; manager?: TmuxTerminalManager; child?: Bun.Subprocess }[] = [];
async function until(check: () => boolean | Promise<boolean>, label: string, timeout = 8000): Promise<void> { const end = Date.now() + timeout; while (!await check()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await Bun.sleep(15); } }
const program = `import {readFileSync,writeFileSync,renameSync,appendFileSync} from 'node:fs';
const dir=process.cwd();let last=0;const state={pid:process.pid,done:0,winches:[],interrupts:0};
const save=()=>{writeFileSync(dir+'/state.new',JSON.stringify(state));renameSync(dir+'/state.new',dir+'/state.json')};
process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data',data=>appendFileSync(dir+'/input.bin',data));
process.on('SIGWINCH',()=>{const s=new TextDecoder().decode(Bun.spawnSync(['stty','size'],{stdin:'inherit',stdout:'pipe'}).stdout).trim().split(/\\s+/).map(Number);state.winches.push([s[1],s[0]]);save()});
process.on('SIGINT',()=>{state.interrupts++;save()});
process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[H\\x1b[32mNATIVE STATIC HEADER\\x1b[0m\\x1b[3;4H');save();
setInterval(async()=>{let command;try{command=JSON.parse(readFileSync(dir+'/control.json','utf8'))}catch{return}if(command.id<=last)return;last=command.id;
if(command.type==='output')process.stdout.write(command.data);
if(command.type==='flood'){for(let i=0;i<80;i++){for(let row=3;row<23;row++)process.stdout.write('\\x1b['+row+';1H'+('UPDATE_'+i).padEnd(80,String.fromCharCode(65+i%26)));await Bun.sleep(10);}process.stdout.write('\\x1b[8;1H'+('FINAL CURRENT FRAME').padEnd(80,' ')+'\\x1b[5;9H');}
if(command.type==='history'){process.stdout.write('\\x1b[?1049l\\x1b[2J\\x1b[H');for(let i=0;i<1400;i++)process.stdout.write('HISTORY_'+i+'\\r\\n');process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[HALTERNATE FRAME');}
if(command.type==='cooked')process.stdin.setRawMode(false);if(command.type==='raw')process.stdin.setRawMode(true);if(command.type==='exit'){await new Promise(resolve=>process.stdout.write('\\x1b[?1049l\\x1b[2J\\x1b[HFINAL EXIT OUTPUT',resolve));process.exit(command.code??7);}
state.done=command.id;save();},5);`;
async function fixture(extra: Partial<Parameters<typeof TmuxTerminalManager.open>[0]> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "agent-native-terminal-test-")); writeFileSync(join(directory, "fixture.mjs"), program);
  const resource = { directory, manager: undefined as TmuxTerminalManager | undefined }; fixtures.push(resource);
  const manager = await TmuxTerminalManager.open({ dataDirectory: directory, hostId: crypto.randomUUID(), bundleDirectory: resolve(bundle!), shell: { application: process.execPath, args: [join(directory, "fixture.mjs"), directory] }, maximumOutputBytes: 16 * 1024, pollIntervalMs: 100, ...extra }); resource.manager = manager;
  const terminal = await manager.create({ cwd: directory, target: { projectId: crypto.randomUUID() }, cols: 80, rows: 24 });
  const state = () => JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as { pid: number; done: number; winches: number[][]; interrupts: number };
  await until(() => existsSync(join(directory, "state.json")), "program ready");
  let ordinal = 0;
  const command = async (type: string, data = "") => { const id = ++ordinal; writeFileSync(join(directory, "control.json"), JSON.stringify({ id, type, data })); await until(() => state().done === id, `program ${type}`); await Bun.sleep(80); };
  const bytes = () => existsSync(join(directory, "input.bin")) ? readFileSync(join(directory, "input.bin")) : Buffer.alloc(0);
  return { directory, manager, terminal, state, command, bytes };
}
async function viewer(manager: TmuxTerminalManager, terminalId: string) {
  const attachment = await manager.attach(terminalId, crypto.randomUUID()), xterm = new Terminal({ cols: attachment.cols, rows: attachment.rows, allowProposedApi: true });
  let cursor = 0, sequence = 0, ordinal = 0;
  const subscription = xterm.onData(data => { manager.reply(attachment.id, sequence, ++ordinal, data); });
  const drain = async () => { const replay = manager.replay(attachment.id, cursor); if (replay.resetRequired) return false; for (const chunk of replay.chunks) { sequence = chunk.sequence; ordinal = 0; await new Promise<void>(resolve => xterm.write(chunk.data, resolve)); cursor = chunk.sequence; } manager.heartbeat(attachment.id, cursor, attachment.geometryRevision); return true; };
  const screen = () => ({ rows: Array.from({ length: xterm.rows }, (_, row) => xterm.buffer.active.getLine(row)?.translateToString(true)), cursor: [xterm.buffer.active.cursorX, xterm.buffer.active.cursorY] });
  return { attachment, xterm, drain, screen, close: async () => { subscription.dispose(); xterm.dispose(); await manager.detach(attachment.id); } };
}
afterEach(async () => { for (const resource of fixtures.splice(0)) { if (resource.child && resource.child.exitCode === null) { resource.child.kill(); await resource.child.exited; } await resource.manager?.shutdown(); rmSync(resource.directory, { recursive: true, force: true }); } });

describe.skipIf(!bundle)("private bundled tmux integration (actual native programs)", () => {
  test("UTF-8 attachment output is independent of the owning host locale", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-native-utf8-"));
    const manager = await TmuxTerminalManager.open({ dataDirectory: directory, hostId: crypto.randomUUID(), bundleDirectory: resolve(bundle!),
      shell: { application: "/bin/sh", args: ["-c", "printf 'café λ 界\\n'; read hold"], environment: { LANG: "C", LC_ALL: "C" } }, pollIntervalMs: 100 });
    fixtures.push({ directory, manager });
    const terminal = await manager.create({ cwd: directory, target: { projectId: crypto.randomUUID() }, cols: 80, rows: 24 });
    const attached = await viewer(manager, terminal.id);
    try {
      await until(async () => { await attached.drain(); return attached.screen().rows.some(row => row?.includes("caf")); }, "native Unicode output");
      expect(attached.screen().rows.join("\n")).toContain("café λ 界");
    } finally { await attached.close(); }
  });

  for (const shell of [{ application: "/bin/bash", args: ["--noprofile", "--norc", "-i"] }, ...(existsSync("/bin/zsh") ? [{ application: "/bin/zsh", args: ["-f", "-i"] }, { application: "/bin/zsh", args: ["-f", "-i"], environment: { PROMPT: "fixture " + "long-path/".repeat(27) + " detached at fixture\n❯ " } }] : [])]) test(`completed action output survives a wide, short dock resize without rerunning (${shell.application}${"environment" in shell ? " wrapped prompt" : ""})`, async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "agent-native-action-resize-")));
    const manager = await TmuxTerminalManager.open({ dataDirectory: directory, hostId: crypto.randomUUID(), bundleDirectory: resolve(bundle!),
      shell, pollIntervalMs: 100 });
    fixtures.push({ directory, manager });
    const terminal = await manager.create({ cwd: directory, target: { projectId: crypto.randomUUID() }, cols: 120, rows: 40 }, undefined, { actionKey: "b".repeat(64) });
    const count = join(directory, "runs");
    for (const name of ["FIRST", "SECOND"]) {
      await manager.restartAction(terminal.id, `printf '${name}\\n' >> ${quote(count)}; printf 'COLOR=fixture\\n'; printf 'DONE_%s\\n' '${name}'`);
      await until(async () => (await manager.history(terminal.id)).screen?.split("\n").includes(`DONE_${name}`) ?? false, `actual ${name} output`);
    }
    const before = await manager.history(terminal.id);
    const attachment = await manager.attach(terminal.id, crypto.randomUUID());
    await manager.resize(terminal.id, attachment.id, attachment.geometryRevision, 145, 8);
    // Reattach the real viewer and let shell SIGWINCH/prompt replies settle.
    const resizedViewer = await viewer(manager, terminal.id);
    for (let sample = 0; sample < 3; sample++) { await Bun.sleep(200); await resizedViewer.drain(); }
    await resizedViewer.close();
    const after = await manager.history(terminal.id);
    for (const name of ["SECOND"]) {
      expect([before.history, before.screen].join("\n").split("\n")).toContain(`DONE_${name}`);
      expect([after.history, after.screen].join("\n").split("\n")).toContain(`DONE_${name}`);
    }
    expect(readFileSync(count, "utf8")).toBe("FIRST\nSECOND\n");
  }, 20_000);
  test("per-terminal setup environments stay private across two panes and manager adoption", async () => {
    const processEnvironment = { terminal:process.env.TERMINAL_VALUE, worktree:process.env.CODEX_WORKTREE_PATH };
    const directory = mkdtempSync(join(tmpdir(), "agent-native-terminal-environment-")), source = join(directory, "source"), one = join(directory, "one"), two = join(directory, "two"), three = join(directory, "three");
    for (const path of [source, one, two, three]) mkdirSync(path);
    const probe = join(directory, "environment-probe.mjs"), managerModule = new URL("./native-manager.ts", import.meta.url).pathname, hostId = crypto.randomUUID();
    writeFileSync(probe, `import {writeFileSync} from 'node:fs';const keys=['TERMINAL_VALUE','REMOVE_ME','STALE_UNSET','EXPLICIT_SAME','CODEX_SOURCE_TREE_PATH','CODEX_WORKTREE_PATH','AGENT_SOURCE_TREE_PATH','AGENT_WORKTREE_PATH','TERM','TERMINFO','COLORTERM'];writeFileSync(${JSON.stringify(directory+'/environment-')}+(process.env.TERMINAL_VALUE??'missing')+'.json',JSON.stringify(Object.fromEntries(keys.map(key=>[key,process.env[key]??null]))));setInterval(()=>{},1000);`);
    const initialOptions = { dataDirectory: directory, hostId, bundleDirectory: resolve(bundle!), shell: { application: process.execPath, args: [probe], environment: { REMOVE_ME: "server-value", STALE_UNSET: "stale-global", EXPLICIT_SAME: "same" } }, pollIntervalMs: 100 };
    writeFileSync(join(directory, "owner.ts"), `import {writeFileSync} from 'node:fs';import {TmuxTerminalManager} from ${JSON.stringify(managerModule)};const manager=await TmuxTerminalManager.open(${JSON.stringify(initialOptions)});const source=${JSON.stringify(source)};const make=(cwd,value,delta)=>manager.create({cwd,target:{projectId:crypto.randomUUID()},cols:80,rows:24},{sourceRoot:source,worktreeRoot:cwd,environmentDelta:{version:1,set:{TERMINAL_VALUE:value,...delta},unset:value==='first'?['REMOVE_ME']:[]}});const terminals=[await make(${JSON.stringify(one)},'first',{EXPLICIT_SAME:'same'}),await make(${JSON.stringify(two)},'second',{REMOVE_ME:'pane-two'})];writeFileSync(${JSON.stringify(join(directory,"ready.json"))},JSON.stringify(terminals));setInterval(()=>{},1000);`);
    const ownerError = join(directory,"owner.stderr");
    const child = Bun.spawn([process.execPath, join(directory, "owner.ts")], { stdout: "pipe", stderr: Bun.file(ownerError) });
    const resource = { directory, child, manager: undefined as TmuxTerminalManager | undefined }; fixtures.push(resource);
    try { await until(() => child.exitCode !== null || existsSync(join(directory, "ready.json")) && existsSync(join(directory, "environment-first.json")) && existsSync(join(directory, "environment-second.json")), "isolated terminal environments"); }
    catch { throw new Error(`Environment terminal owner stalled. ${readFileSync(ownerError,"utf8")}`); }
    if (child.exitCode !== null) throw new Error(`Environment terminal owner exited: ${readFileSync(ownerError,"utf8")}`);
    const terminals = JSON.parse(readFileSync(join(directory, "ready.json"), "utf8"));
    const first = JSON.parse(readFileSync(join(directory, "environment-first.json"), "utf8")), second = JSON.parse(readFileSync(join(directory, "environment-second.json"), "utf8"));
    expect(first).toMatchObject({ TERMINAL_VALUE:"first", REMOVE_ME:null, EXPLICIT_SAME:"same", CODEX_SOURCE_TREE_PATH:source, AGENT_SOURCE_TREE_PATH:source, CODEX_WORKTREE_PATH:one, AGENT_WORKTREE_PATH:one, TERM:"xterm-256color",COLORTERM:"truecolor" });
    expect(second).toMatchObject({ TERMINAL_VALUE:"second", REMOVE_ME:"pane-two", CODEX_WORKTREE_PATH:two, AGENT_WORKTREE_PATH:two });
    expect({ terminal:process.env.TERMINAL_VALUE, worktree:process.env.CODEX_WORKTREE_PATH }).toEqual(processEnvironment);
    const catalogPath = join(directory,"native-terminals-v1/catalog.json"), catalogText = readFileSync(catalogPath,"utf8"), catalog = JSON.parse(catalogText);
    const global = Bun.spawnSync([join(resolve(bundle!),"bin/tmux"),"-S",catalog.socket,"show-environment","-g"],{stdout:"pipe",stderr:"pipe",env:{...process.env,TMUX:undefined}});
    expect(global.exitCode).toBe(0); const globalText = new TextDecoder().decode(global.stdout);
    expect(globalText).toContain("REMOVE_ME=server-value"); expect(globalText).not.toContain("TERMINAL_VALUE"); expect(globalText).not.toContain("CODEX_WORKTREE_PATH");
    expect(catalogText).not.toContain("first"); expect(catalogText).not.toContain("pane-two");
    expect(readdirSync(join(directory,"native-terminals-v1")).filter(name=>name.startsWith("environment-launch-"))).toEqual([]);
    child.kill("SIGKILL"); await child.exited;
    const reopened = await TmuxTerminalManager.open({ ...initialOptions, shell: { ...initialOptions.shell, environment: { EXPLICIT_SAME:"new-daemon" } } }); resource.manager = reopened;
    expect(reopened.get(terminals[0].id).pid).toBe(terminals[0].pid); expect(reopened.get(terminals[1].id).pid).toBe(terminals[1].pid);
    const third = await reopened.create({cwd:three,target:{projectId:crypto.randomUUID()},cols:80,rows:24},{sourceRoot:source,worktreeRoot:three,environmentDelta:{version:1,set:{EXPLICIT_SAME:"new-daemon",TERMINAL_VALUE:"third"},unset:["STALE_UNSET"]}});
    await until(()=>existsSync(join(directory,"environment-third.json")),"adopted-server terminal environment");
    expect(JSON.parse(readFileSync(join(directory,"environment-third.json"),"utf8"))).toMatchObject({TERMINAL_VALUE:"third",EXPLICIT_SAME:"new-daemon",STALE_UNSET:null,CODEX_WORKTREE_PATH:three});
    expect(JSON.stringify(reopened.list())).not.toContain("new-daemon"); expect(reopened.get(third.id).cwd).toBe(realpathSync(three));
  }, 20_000);

  test("environment ownership mismatch is rejected before another pane is created", async () => {
    const f = await fixture(), other = mkdtempSync(join(tmpdir(),"agent-native-terminal-other-")); fixtures.push({directory:other});
    await expect(f.manager.create({cwd:f.directory,target:{projectId:crypto.randomUUID()}},{sourceRoot:f.directory,worktreeRoot:other,environmentDelta:null})).rejects.toThrow("does not own");
    expect(f.manager.list()).toHaveLength(1);
  });

  test("configured actions keep their cwd and environment aliases inside one trusted nested worktree", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "agent-native-nested-action-")));
    const managed = join(directory, "managed"), nested = join(managed, "apps", "web"), source = join(directory, "source"), outside = join(directory, "outside");
    for (const path of [managed, nested, source, outside]) mkdirSync(path, { recursive: true });
    const resource = { directory, manager: undefined as TmuxTerminalManager | undefined }; fixtures.push(resource);
    const manager = await TmuxTerminalManager.open({ dataDirectory: join(directory, "state"), hostId: crypto.randomUUID(), bundleDirectory: resolve(bundle!),
      shell: { application: "/bin/bash", args: ["--noprofile", "--norc", "-i"] }, pollIntervalMs: 100 });
    resource.manager = manager;
    const environment = { sourceRoot: source, worktreeRoot: nested,
      environmentDelta: { version: 1 as const, set: { NESTED_ACTION_VALUE: "private-nested" }, unset: [] } };
    const key = "c".repeat(64), target = { sessionId: crypto.randomUUID() };
    const terminal = await manager.create({ cwd: managed, target }, environment, { actionKey: key, actionRoot: managed });
    const result = join(managed, "nested-action.json");
    await manager.restartAction(terminal.id,
      `printf '{"cwd":"%s","worktree":"%s","agent":"%s","source":"%s","value":"%s"}' "$PWD" "$CODEX_WORKTREE_PATH" "$AGENT_WORKTREE_PATH" "$CODEX_SOURCE_TREE_PATH" "$NESTED_ACTION_VALUE" > ${quote(`${result}.pending`)} && mv ${quote(`${result}.pending`)} ${quote(result)}`,
      environment, { actionRoot: managed });
    await until(() => existsSync(result), "nested action environment");
    expect(JSON.parse(readFileSync(result, "utf8"))).toEqual({ cwd: managed, worktree: nested, agent: nested, source, value: "private-nested" });
    expect(manager.getAction(key)).toMatchObject({ id: terminal.id, cwd: managed });

    await expect(manager.create({ cwd: managed, target: { projectId: crypto.randomUUID() } }, environment,
      { actionKey: "d".repeat(64), actionRoot: outside })).rejects.toMatchObject({ code: "INVALID_TERMINAL_ENVIRONMENT" });
    await expect(manager.restartAction(terminal.id, "true", { ...environment, worktreeRoot: outside }, { actionRoot: managed }))
      .rejects.toMatchObject({ code: "INVALID_TERMINAL_ENVIRONMENT" });
    expect(manager.list()).toHaveLength(1);
  }, 20_000);

  test("configured actions restart one native pane under the same terminal identity", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "agent-native-terminal-action-")));
    const resource = { directory, manager: undefined as TmuxTerminalManager | undefined }; fixtures.push(resource);
    const hostId = crypto.randomUUID(), actionKey = "a".repeat(64), target = { projectId: crypto.randomUUID() };
    const manager = await TmuxTerminalManager.open({
      dataDirectory: directory, hostId, bundleDirectory: resolve(bundle!), pollIntervalMs: 100,
      shell: { application: "/bin/bash", args: ["--noprofile", "--norc", "-i"] },
    });
    resource.manager = manager;
    const environment = (value: string) => ({
      sourceRoot: directory, worktreeRoot: directory,
      environmentDelta: { version: 1 as const, set: { ACTION_PRIVATE_VALUE: value }, unset: [] },
    });
    const action = await manager.create({ cwd: directory, target, cols: 80, rows: 24 }, environment("initial-private"), { actionKey });
    const other = await manager.create({ cwd: directory, target: { projectId: crypto.randomUUID() }, cols: 80, rows: 24 });
    expect(manager.getAction(actionKey)?.id).toBe(action.id);
    await expect(manager.create({ cwd: directory, target }, undefined, { actionKey })).rejects.toThrow("already owns");
    const oldViewer = await manager.attach(action.id, crypto.randomUUID());

    const count = join(directory, "action-count"), firstEnvironment = join(directory, "action-first-env"), childFile = join(directory, "action-child.pid");
    const firstCommand = `printf 'first\\n' >> ${quote(count)}; printf '%s' "$ACTION_PRIVATE_VALUE" > ${quote(firstEnvironment)}; sleep 30 & echo $! > ${quote(childFile)}; wait`;
    const first = await manager.restartAction(action.id, firstCommand, environment("first-private-value"));
    expect(first.id).toBe(action.id); expect(first.pid).not.toBe(action.pid);
    expect(() => manager.replay(oldViewer.id, 0)).toThrow("expired");
    await until(() => existsSync(childFile) && existsSync(firstEnvironment), "first configured action");
    const priorChild = Number(readFileSync(childFile, "utf8").trim());
    expect(readFileSync(firstEnvironment, "utf8")).toBe("first-private-value");

    const secondEnvironment = join(directory, "action-second-env");
    const secondCommand = `printf 'second\\n' >> ${quote(count)}; printf '%s' "$ACTION_PRIVATE_VALUE" > ${quote(secondEnvironment)}`;
    const second = await manager.restartAction(action.id, secondCommand, environment("second-private-value"));
    expect(second).toMatchObject({ id: action.id, status: "running" });
    expect(second.pid).not.toBe(first.pid); expect(manager.get(other.id).pid).toBe(other.pid);
    await until(() => existsSync(secondEnvironment) && Process.fromPid(priorChild)?.status() !== "running", "replacement action and old process-tree exit");
    expect(readFileSync(count, "utf8")).toBe("first\nsecond\n");
    expect(readFileSync(secondEnvironment, "utf8")).toBe("second-private-value");

    const catalog = JSON.parse(readFileSync(join(directory, "native-terminals-v1", "catalog.json"), "utf8"));
    const pane = Bun.spawnSync([join(resolve(bundle!), "bin/tmux"), "-S", catalog.socket, "display-message", "-p", "-t", catalog.terminals.find((item: any) => item.info.id === action.id).paneId, "#{pane_current_command}"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, TMUX: undefined } });
    expect(pane.exitCode).toBe(0); expect(new TextDecoder().decode(pane.stdout).trim()).toBe("bash");
    const publicText = JSON.stringify([manager.get(action.id), manager.list(), manager.getAction(actionKey)]);
    for (const privateText of ["first-private-value", "second-private-value", "ACTION_PRIVATE_VALUE", "action-count"])
      expect(publicText).not.toContain(privateText);
    const catalogText = JSON.stringify(catalog);
    expect(catalogText).not.toContain("first-private-value"); expect(catalogText).not.toContain(firstCommand);
    await manager.close(action.id);
    const reopened = await manager.restartAction(action.id, `printf 'third\\n' >> ${quote(count)}`);
    expect(reopened).toMatchObject({ id: action.id, status: "running" });
    await until(() => readFileSync(count, "utf8") === "first\nsecond\nthird\n", "explicit run after closed action");
    expect(manager.get(other.id).pid).toBe(other.pid);
  }, 20_000);

  test("a lost action restart receipt stays unknown across reopen and is never replayed", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "agent-native-terminal-action-unknown-")));
    const resource = { directory, manager: undefined as TmuxTerminalManager | undefined }; fixtures.push(resource);
    const options = {
      dataDirectory: directory, hostId: crypto.randomUUID(), bundleDirectory: resolve(bundle!), pollIntervalMs: 100,
      shell: { application: "/bin/bash", args: ["--noprofile", "--norc", "-i"] },
    };
    let manager = await TmuxTerminalManager.open(options); resource.manager = manager;
    const actionKey = "b".repeat(64), terminal = await manager.create({ cwd: directory, target: { projectId: crypto.randomUUID() } }, undefined, { actionKey });
    const internal = manager as unknown as { cli(command: string[], maximumBytes?: number): Promise<string> };
    const nativeCli = internal.cli.bind(manager); let respawns = 0;
    internal.cli = async (command, maximumBytes) => {
      const output = await nativeCli(command, maximumBytes);
      if (command[0] === "respawn-pane") { respawns++; throw new Error("Injected lost respawn acknowledgement"); }
      return output;
    };
    const marker = join(directory, "must-not-replay"), command = `printf replayed > ${quote(marker)}`;
    await expect(manager.restartAction(terminal.id, command)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(manager.get(terminal.id)).toMatchObject({ id: terminal.id, pid: null, status: "error", attachable: false });
    await expect(manager.restartAction(terminal.id, command)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(respawns).toBe(1); expect(existsSync(marker)).toBe(false);
    internal.cli = nativeCli;
    await manager.shutdown();
    manager = await TmuxTerminalManager.open(options); resource.manager = manager;
    expect(manager.getAction(actionKey)).toMatchObject({ id: terminal.id, attachable: false });
    await expect(manager.restartAction(terminal.id, command)).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(existsSync(marker)).toBe(false);
  }, 20_000);

  for (const code of [0, 7]) for (const cleanup of ["close", "shutdown"] as const) {
    test(`retained natural exit ${code} preserves its outcome through ${cleanup} and reopen`, async () => {
      const f = await fixture();
      writeFileSync(join(f.directory, "control.json"), JSON.stringify({ id: 999, type: "exit", code }));
      await until(() => f.manager.get(f.terminal.id).status === "exited", "natural program exit");
      const before = f.manager.get(f.terminal.id), history = await f.manager.history(f.terminal.id);
      expect(before.exitCode).toBe(code); expect(before.cancelled).toBeUndefined();
      expect(history.screen).toContain("FINAL EXIT OUTPUT");
      if (cleanup === "close") await f.manager.close(f.terminal.id); else await f.manager.shutdown();
      const after = f.manager.get(f.terminal.id);
      expect({ exitedAt: after.exitedAt, exitCode: after.exitCode, cancelled: after.cancelled }).toEqual({ exitedAt: before.exitedAt, exitCode: code, cancelled: undefined });
      expect(after.status).toBe("exited"); expect(after.attachable).toBe(false);
      await f.manager.shutdown();
      const catalog = JSON.parse(readFileSync(join(f.directory, "native-terminals-v1/catalog.json"), "utf8"));
      const reopened = await TmuxTerminalManager.open({ dataDirectory: f.directory, hostId: catalog.hostId, bundleDirectory: resolve(bundle!) });
      fixtures.find(resource => resource.directory === f.directory)!.manager = reopened;
      expect(reopened.get(f.terminal.id)).toMatchObject({ status: "exited", exitedAt: before.exitedAt, exitCode: code, attachable: false });
      expect(reopened.get(f.terminal.id).cancelled).toBeUndefined();
      expect(await reopened.history(f.terminal.id)).toMatchObject({ revision: history.revision, cols: history.cols, rows: history.rows, screen: history.screen, live: false });
    }, 10_000);
  }
  for (const code of [0, 7]) test(`native exit ${code} before the next poll is not relabelled as cancellation`, async () => {
    const f = await fixture({ pollIntervalMs: 10_000 });
    const catalog = JSON.parse(readFileSync(join(f.directory, "native-terminals-v1/catalog.json"), "utf8"));
    const record = catalog.terminals.find((record: any) => record.info.id === f.terminal.id);
    writeFileSync(join(f.directory, "control.json"), JSON.stringify({ id: 999, type: "exit", code }));
    await until(() => {
      const result = Bun.spawnSync([join(resolve(bundle!), "bin/tmux"), "-S", catalog.socket, "display-message", "-p", "-t", record.paneId, "#{pane_dead}|#{pane_dead_status}"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, TMUX: undefined } });
      return result.exitCode === 0 && new TextDecoder().decode(result.stdout).trim() === `1|${code}`;
    }, "real native exit before host polling");
    expect(f.manager.get(f.terminal.id).status).toBe("running");
    if (code === 0) await f.manager.close(f.terminal.id); else await f.manager.shutdown();
    const final = f.manager.get(f.terminal.id);
    expect(final).toMatchObject({ status: "exited", exitCode: code, attachable: false });
    expect(final.cancelled).toBeUndefined(); expect(final.exitedAt).toBeGreaterThan(f.terminal.createdAt);
    const history = await f.manager.history(f.terminal.id); expect(history.screen).toContain("FINAL EXIT OUTPUT");
    await f.manager.shutdown();
    const reopened = await TmuxTerminalManager.open({ dataDirectory: f.directory, hostId: catalog.hostId, bundleDirectory: resolve(bundle!) });
    fixtures.find(resource => resource.directory === f.directory)!.manager = reopened;
    expect(reopened.get(f.terminal.id)).toMatchObject({ status: "exited", exitedAt: final.exitedAt, exitCode: code });
    expect(reopened.get(f.terminal.id).cancelled).toBeUndefined();
    expect(await reopened.history(f.terminal.id)).toMatchObject({ revision: history.revision, screen: history.screen, live: false });
  }, 10_000);

  test("concurrent history callers share one native snapshot", async () => {
    const f = await fixture({ pollIntervalMs: 10_000 });
    const internal = f.manager as unknown as { cli(command: string[], maximumBytes?: number): Promise<string> };
    const nativeCli = internal.cli.bind(f.manager);
    let snapshots = 0, begin!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { begin = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    internal.cli = async (command, maximumBytes) => {
      if (command[0] === "display-message" && command.at(-1) === "#{history_size}|#{alternate_on}") {
        snapshots++;
        if (snapshots === 1) { begin(); await held; }
      }
      return nativeCli(command, maximumBytes);
    };
    try {
      const first = f.manager.history(f.terminal.id);
      await started;
      const second = f.manager.history(f.terminal.id);
      await Bun.sleep(50);
      const admitted = snapshots;
      release();
      const [one, two] = await Promise.all([first, second]);
      expect(admitted).toBe(1);
      expect(two).toEqual(one);
    } finally { release(); internal.cli = nativeCli; }
  });

  test("retained-pane cleanup errors stay observable without replacing the natural outcome", async () => {
    const f = await fixture();
    writeFileSync(join(f.directory, "control.json"), JSON.stringify({ id: 999, type: "exit", code: 7 }));
    await until(() => f.manager.get(f.terminal.id).status === "exited", "natural exit");
    const before = f.manager.get(f.terminal.id), history = await f.manager.history(f.terminal.id);
    const catalog = JSON.parse(readFileSync(join(f.directory, "native-terminals-v1/catalog.json"), "utf8"));
    const record = catalog.terminals.find((record: any) => record.info.id === f.terminal.id);
    const result = Bun.spawnSync([join(resolve(bundle!), "bin/tmux"), "-S", catalog.socket, "kill-session", "-t", record.sessionName], { stdout: "pipe", stderr: "pipe", env: { ...process.env, TMUX: undefined } });
    expect(result.exitCode).toBe(0);
    await expect(f.manager.close(f.terminal.id)).rejects.toThrow();
    expect(f.manager.get(f.terminal.id)).toMatchObject({ status: "exited", exitedAt: before.exitedAt, exitCode: 7 });
    expect(f.manager.get(f.terminal.id).cancelled).toBeUndefined(); expect(f.manager.get(f.terminal.id).error).toBeTruthy();
    await expect(f.manager.shutdown()).rejects.toThrow("failed to close");
    const reopened = await TmuxTerminalManager.open({ dataDirectory: f.directory, hostId: catalog.hostId, bundleDirectory: resolve(bundle!) });
    fixtures.find(resource => resource.directory === f.directory)!.manager = reopened;
    expect(reopened.get(f.terminal.id)).toMatchObject({ status: "exited", exitedAt: before.exitedAt, exitCode: 7 });
    expect(reopened.get(f.terminal.id).error).toBeTruthy();
    expect(await reopened.history(f.terminal.id)).toMatchObject({ revision: history.revision, screen: history.screen, live: false });
  }, 10_000);
  test("fresh native attachment reconstructs a truncated full-screen TUI and continues the same program", async () => {
    const f = await fixture(), first = await viewer(f.manager, f.terminal.id);
    await until(async () => { await first.drain(); return first.screen().rows[0]?.includes("NATIVE STATIC HEADER") ?? false; }, "initial native screen");
    const pid = f.terminal.pid; await f.command("flood");
    expect(f.manager.replay(first.attachment.id, 0).resetRequired).toBe(true);
    expect(f.manager.replay(first.attachment.id, 0).chunks).toEqual([]);
    const second = await viewer(f.manager, f.terminal.id);
    await until(async () => { await second.drain(); return second.screen().rows[7]?.includes("FINAL CURRENT FRAME") ?? false; }, "fresh current native frame");
    expect(second.screen().rows[0]).toContain("NATIVE STATIC HEADER");
    expect(f.manager.get(f.terminal.id).pid).toBe(pid); expect(f.state().winches).toEqual([]);
    await first.close();
    // Native tmux retains pending parser state; a partial CSI is never reconstructed by an application codec.
    await f.command("output", "\x1b[12;"); await second.close();
    const third = await viewer(f.manager, f.terminal.id); await Bun.sleep(100); await third.drain();
    await f.command("output", "5HCONTINUED");
    await until(async () => { await third.drain(); return third.screen().rows[11]?.slice(4, 13) === "CONTINUED"; }, "native partial-CSI continuation");
    expect(f.state().winches).toEqual([]); await third.close();
  }, 20_000);

  test("native ordered key/text/paste/mouse/binary input, duplicate receipts and accepted grid", async () => {
    const f = await fixture(), a = await viewer(f.manager, f.terminal.id), b = await viewer(f.manager, f.terminal.id);
    await Bun.sleep(150); await a.drain(); await b.drain();
    const clientId = crypto.randomUUID(); let sequence = 0;
    const request = (input: NativeTerminalInput, attachment: NativeTerminalAttachment = a.attachment) => ({ terminalId: f.terminal.id, attachmentId: attachment.id, inputEpoch: attachment.inputEpoch, geometryRevision: attachment.geometryRevision, clientId, sequence: ++sequence, input });
    const before = f.bytes().length, expected: Buffer[] = [], operations: Promise<unknown>[] = [];
    for (let i = 0; i < 48; i++) { const text = `<${i}>`, value = request({ kind: "text", data: text }); expected.push(Buffer.from(text)); operations.push(f.manager.input(value)); if (i % 7 === 0) operations.push(f.manager.input(value).then(receipt => expect(receipt.duplicate).toBe(true))); }
    await Promise.all(operations); await until(() => f.bytes().length >= before + Buffer.concat(expected).length, "ordered bytes");
    expect(f.bytes().subarray(before)).toEqual(Buffer.concat(expected));
    expect(() => f.manager.input({ ...request({ kind: "text", data: "changed" }), sequence: 1 })).toThrow("already used");
    sequence--;
    const send = async (input: NativeTerminalInput, bytes: Uint8Array) => { const start = f.bytes().length; expect((await f.manager.input(request(input))).outcome).toBe("accepted"); await until(() => f.bytes().length >= start + bytes.length, "typed input bytes"); await Bun.sleep(30); expect(f.bytes().subarray(start)).toEqual(Buffer.from(bytes)); };
    await send({ kind: "key", key: "Up" }, Buffer.from("\x1b[A"));
    await send({ kind: "key", key: "C-\\" }, Buffer.from([28]));
    await f.command("output", "\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[?1006h");
    await send({ kind: "key", key: "Up" }, Buffer.from("\x1bOA"));
    await send({ kind: "paste", data: "界\ntext" }, Buffer.from("\x1b[200~界\rtext\x1b[201~"));
    await send({ kind: "mouse", button: 0, col: 10, row: 5, release: false }, Buffer.from("\x1b[<0;10;5M"));
    await send({ kind: "bytes", base64: Buffer.from([0, 3, 27, 127, 128, 193, 254, 255]).toString("base64") }, Buffer.from([0, 3, 27, 127, 128, 193, 254, 255]));
    const resized = await f.manager.resize(f.terminal.id, a.attachment.id, a.attachment.geometryRevision, 120, 30);
    expect(resized.geometryRevision).toBe(2); expect(() => f.manager.replay(b.attachment.id, 0)).toThrow("expired");
    const stale = await f.manager.input(request({ kind: "text", data: "MUST_NOT_WRITE" })); expect(stale.outcome).toBe("not-submitted");
    const c = await viewer(f.manager, f.terminal.id); await Bun.sleep(100); await c.drain();
    expect(c.attachment.cols).toBe(120); expect(c.attachment.rows).toBe(30);
    expect((await f.manager.input(request({ kind: "mouse", button: 0, col: 100, row: 5, release: false }, c.attachment))).outcome).toBe("accepted");
    await until(() => f.state().winches.length === 1, "exactly one intentional native resize"); expect(f.state().winches).toEqual([[120, 30]]);
    await a.close(); await b.close(); await c.close();
  }, 20_000);

  test("two real programs stay independent; bounded shared history survives detach and explicit close", async () => {
    const f = await fixture({ historyRows: 1000 }), a = await viewer(f.manager, f.terminal.id);
    const secondDirectory = mkdtempSync(join(tmpdir(), "agent-native-second-")); fixtures.push({ directory: secondDirectory }); writeFileSync(join(secondDirectory, "fixture.mjs"), program);
    // Both programs use the same host-approved executable; the second cwd is independent.
    const second = await f.manager.create({ cwd: secondDirectory, target: { projectId: crypto.randomUUID() }, cols: 80, rows: 24 });
    expect(second.pid).not.toBe(f.terminal.pid); await f.command("history");
    const one = await f.manager.history(f.terminal.id), two = await f.manager.history(f.terminal.id);
    expect(one.revision).toBe(two.revision); expect(one.history).toContain("HISTORY_1300"); expect(one.history).not.toContain("HISTORY_0\n"); expect(one.savedNormalScreen).toContain("HISTORY_1399");
    await a.close(); expect(f.manager.get(f.terminal.id).status).toBe("running");
    await f.manager.close(f.terminal.id); const saved = await f.manager.history(f.terminal.id); expect(saved.live).toBe(false); expect(saved.revision).toBe(one.revision);
    expect(f.manager.get(f.terminal.id)).toMatchObject({ status: "exited", cancelled: true });
    expect(f.manager.get(f.terminal.id).exitedAt).toBeGreaterThan(f.terminal.createdAt);
    expect(f.manager.get(second.id).status).toBe("running");
    await f.manager.close(second.id); await f.manager.forget(f.terminal.id); expect(f.manager.list().length).toBe(1);
  }, 20_000);

  test("SIGKILL owner recovery adopts the same native pane; missing native server never reruns it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-native-recover-")); writeFileSync(join(directory, "fixture.mjs"), program);
    const hostId = crypto.randomUUID(), managerModule = new URL("./native-manager.ts", import.meta.url).pathname;
    writeFileSync(join(directory, "owner.ts"), `import {writeFileSync} from 'node:fs';import {TmuxTerminalManager} from ${JSON.stringify(managerModule)};const manager=await TmuxTerminalManager.open(${JSON.stringify({ dataDirectory: directory, hostId, bundleDirectory: resolve(bundle!), shell: { application: process.execPath, args: [join(directory, "fixture.mjs"), directory] } })});const terminal=await manager.create({cwd:${JSON.stringify(directory)},target:{projectId:crypto.randomUUID()},cols:80,rows:24});writeFileSync(${JSON.stringify(join(directory, "ready.json"))},JSON.stringify(terminal));setInterval(()=>{},1000);`);
    const child = Bun.spawn([process.execPath, join(directory, "owner.ts")], { stdout: "pipe", stderr: "pipe" }); const resource = { directory, child, manager: undefined as TmuxTerminalManager | undefined }; fixtures.push(resource);
    await until(() => existsSync(join(directory, "ready.json")), "owner ready"); const original = JSON.parse(readFileSync(join(directory, "ready.json"), "utf8"));
    child.kill("SIGKILL"); await child.exited;
    expect(() => assertNoNativeTerminalOwnership(directory)).toThrow("native terminal");
    const recovered = await TmuxTerminalManager.open({ dataDirectory: directory, hostId, bundleDirectory: resolve(bundle!), pollIntervalMs: 100 }); resource.manager = recovered;
    expect(recovered.get(original.id).pid).toBe(original.pid); expect(recovered.get(original.id).status).toBe("running"); expect(recovered.get(original.id).inputEpoch).not.toBe(original.inputEpoch);
    const v = await viewer(recovered, original.id); await until(async () => { await v.drain(); return v.screen().rows[0]?.includes("NATIVE STATIC HEADER") ?? false; }, "recovered native screen");
    const catalog = JSON.parse(readFileSync(join(directory, "native-terminals-v1/catalog.json"), "utf8")); const server = Process.fromPid(catalog.serverPid); await server?.terminate({ gracefulMs: 100, timeoutMs: 2000 });
    await until(() => recovered.get(original.id).status === "interrupted", "native server loss is explicit"); expect(await Process.fromPid(original.pid)?.status()).not.toBe("running");
    expect(() => recovered.replay(v.attachment.id, 0)).toThrow("expired"); await v.close();
    await recovered.shutdown(); resource.manager = await TmuxTerminalManager.open({ dataDirectory: directory, hostId, bundleDirectory: resolve(bundle!) });
    expect(resource.manager.get(original.id).status).toBe("interrupted"); expect(resource.manager.list().length).toBe(1);
  }, 20_000);

  test("a lost native control acknowledgement distinguishes uncertain input from an unsent queued operation", async () => {
    const f = await fixture();
    const catalog = JSON.parse(readFileSync(join(f.directory, "native-terminals-v1/catalog.json"), "utf8"));
    const record = catalog.terminals[0];
    const control = new TmuxControl([join(resolve(bundle!), "bin/tmux"), "-S", catalog.socket, "-f", join(f.directory, "native-terminals-v1/tmux.conf"), "-C", "attach-session", "-f", "no-output,ignore-size", "-t", record.sessionName], { ...process.env, TMUX: undefined });
    try {
      const before = f.bytes().length;
      // A real native wait-for delays only this client's acknowledgement after bytes reach the program.
      const submitted = control.execute(`send-keys -t ${record.paneId} -H 4f 4e 43 45 ; wait-for never_${crypto.randomUUID().replaceAll("-", "")}`).then(() => "unexpected", error => error.outcome);
      const queued = control.execute(`send-keys -t ${record.paneId} -H 4e 45 56 45 52`).then(() => "unexpected", error => error.outcome);
      await until(() => f.bytes().subarray(before).includes(Buffer.from("ONCE")), "native input accepted before acknowledgement");
      control.child.kill("SIGKILL"); await control.child.exited;
      expect(await submitted).toBe("uncertain"); expect(await queued).toBe("not-submitted");
      await Bun.sleep(100); expect(f.bytes().subarray(before)).toEqual(Buffer.from("ONCE"));
    } finally { await control.close(); }
  }, 15_000);

  test("focus metadata stays on native attachments and natural exit retains its real final screen", async () => {
    const f = await fixture(), a = await viewer(f.manager, f.terminal.id), b = await viewer(f.manager, f.terminal.id);
    await Bun.sleep(100); await a.drain(); await b.drain(); await f.command("output", "\x1b[?1004h");
    const before = f.bytes().length;
    f.manager.focus(a.attachment.id, false); await Bun.sleep(50); expect(f.bytes().length).toBe(before);
    f.manager.focus(b.attachment.id, false); await until(() => f.bytes().length > before, "native last viewer focus out");
    f.manager.focus(a.attachment.id, true); await until(() => f.bytes().length >= before + 6, "native focused viewer in");
    expect(f.bytes().subarray(before)).toEqual(Buffer.from("\x1b[O\x1b[I"));
    writeFileSync(join(f.directory, "control.json"), JSON.stringify({ id: 999, type: "exit" }));
    await until(() => f.manager.get(f.terminal.id).status === "exited", "natural program exit");
    expect(f.manager.get(f.terminal.id).attachable).toBe(true);
    const c = await viewer(f.manager, f.terminal.id); await until(async () => { await c.drain(); return c.screen().rows[0]?.includes("FINAL EXIT OUTPUT") ?? false; }, "retained natural final screen");
    expect((await f.manager.history(f.terminal.id)).screen).toContain("FINAL EXIT OUTPUT");
    await f.manager.close(f.terminal.id); expect(f.manager.get(f.terminal.id).attachable).toBe(false);
    await a.close(); await b.close(); await c.close();
  }, 15_000);

  test("viewer cap refuses excess clients and a failed controller rotates epochs without duplicating accepted input", async () => {
    const f = await fixture(), a = await viewer(f.manager, f.terminal.id); await Bun.sleep(100); await a.drain();
    const extra: NativeTerminalAttachment[] = [];
    for (let i = 0; i < 15; i++) extra.push(await f.manager.attach(f.terminal.id, crypto.randomUUID()));
    await expect(f.manager.attach(f.terminal.id, crypto.randomUUID())).rejects.toThrow("16 viewers");
    for (const value of extra) await f.manager.detach(value.id);
    const request = { terminalId: f.terminal.id, attachmentId: a.attachment.id, inputEpoch: a.attachment.inputEpoch, geometryRevision: a.attachment.geometryRevision, clientId: crypto.randomUUID(), sequence: 1, input: { kind: "text" as const, data: "ONCE_BEFORE_CONTROL_LOSS" } };
    expect((await f.manager.input(request)).outcome).toBe("accepted"); await until(() => f.bytes().includes(Buffer.from(request.input.data)), "accepted input before idle control loss");
    const catalog = JSON.parse(readFileSync(join(f.directory, "native-terminals-v1/catalog.json"), "utf8"));
    const result = Bun.spawnSync([join(resolve(bundle!), "bin/tmux"), "-S", catalog.socket, "list-clients", "-F", "#{client_pid}|#{client_control_mode}"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, TMUX: undefined } });
    expect(result.exitCode).toBe(0);
    const controllerPid = new TextDecoder().decode(result.stdout).split("\n").map(line => line.split("|")).find(parts => parts[1] === "1")?.[0]; expect(controllerPid).toBeDefined();
    const controller = Process.fromPid(Number(controllerPid)); await controller?.terminate({ gracefulMs: 50, timeoutMs: 1000 });
    await until(() => f.manager.capabilities().inputEpoch !== request.inputEpoch && f.manager.get(f.terminal.id).attachable === true, "input epoch after control loss");
    expect((await f.manager.input(request)).duplicate).toBe(true);
    expect((await f.manager.input({ ...request, sequence: 2, input: { kind: "text", data: "NEVER_OLD_EPOCH" } })).outcome).toBe("not-submitted");
    const b = await viewer(f.manager, f.terminal.id); await Bun.sleep(100); await b.drain();
    expect((await f.manager.input({ ...request, attachmentId: b.attachment.id, inputEpoch: b.attachment.inputEpoch, clientId: crypto.randomUUID(), input: { kind: "text", data: "NEW_EPOCH" } })).outcome).toBe("accepted");
    await until(() => f.bytes().includes(Buffer.from("NEW_EPOCH")), "new epoch input");
    expect(f.bytes().toString()).toBe("ONCE_BEFORE_CONTROL_LOSSNEW_EPOCH"); await a.close(); await b.close();
  }, 15_000);
});
