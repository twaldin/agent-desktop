import { expect, test } from "bun:test";
import { TmuxTerminalManager } from "./native-manager";
const SelectedManager: typeof TmuxTerminalManager = process.env.AGENT_DESKTOP_TERMINAL_RESERVED_MANAGER
  ? (await import(process.env.AGENT_DESKTOP_TERMINAL_RESERVED_MANAGER)).TmuxTerminalManager : TmuxTerminalManager;

/** Actual create body with controlled native command, catalogue and process
 * boundaries. No manager constructor, tmux/server/shell or timers are launched. */
function fixture(options: { payload?: string } = {}) {
  const manager = Object.create(SelectedManager.prototype) as any;
  const terminalId = crypto.randomUUID(), epoch = crypto.randomUUID(), trace: any[] = [];
  Object.assign(manager, { stopping: false, createTail: Promise.resolve(), entries: new Map(), maximumRunning: 32, inputEpoch: epoch,
    shell: { application: "/fixture/shell" }, catalog: { serverGeneration: epoch },
    environmentLaunch: () => ({ application: "/fixture/shell", args: [], ...(options.payload ? { payload: options.payload } : {}) }), prepareServer: async () => {},
    cleanupEnvironmentLaunch: (id: string) => trace.push({ cleanup: id }),
    save: () => trace.push({ save: structuredClone([...manager.entries.values()].map((e: any) => e.record)) }), state: () => {},
    cli: async (args: string[]) => { trace.push({ cli: args }); return ""; }, verifyServer: async () => {},
    panes: async () => [{ session: [...manager.entries.values()][0].record.sessionName, pane: "%1", pid: process.pid, dead: true, code: 0 }],
    publicInfo: (entry: any) => entry.record.info,
  });
  return { manager: manager as TmuxTerminalManager, terminalId, trace,
    input: { target: { projectId: crypto.randomUUID() }, cwd: process.cwd(), cols: 120, rows: 30 } };
}

test("actual native create uses reserved UUID in saved ownership before dispatch and never repeats it", async () => {
  const f = fixture();
  const info = await f.manager.create(f.input, undefined, undefined, { terminalId: f.terminalId, validateOwner() {} });
  expect(info.id).toBe(f.terminalId);
  const firstCommand = f.trace.findIndex(value => value.cli);
  expect(firstCommand).toBeGreaterThan(0);
  expect(f.trace[0].save[0]).toMatchObject({ prepared: true, info: { id: f.terminalId }, sessionName: `agent_${f.terminalId.replaceAll("-", "")}` });
  expect(f.trace.filter(value => value.cleanup)).toEqual([]);
  const before = JSON.stringify(f.trace);
  await expect(f.manager.create(f.input, undefined, undefined, { terminalId: f.terminalId, validateOwner() {} })).rejects.toThrow("already owned");
  expect(JSON.stringify(f.trace)).toBe(before);
});

test("dead payload launch cleans once after reserved ownership is saved and dispatched", async () => {
  const f = fixture({ payload: "/fixture/private-environment.sh" });
  await f.manager.create(f.input, undefined, undefined, { terminalId: f.terminalId, validateOwner() { f.trace.push({ owner: f.terminalId }); } });
  const owner = f.trace.findIndex(value => value.owner);
  const saved = f.trace.findIndex(value => value.save);
  const dispatched = f.trace.findIndex(value => value.cli);
  const cleaned = f.trace.findIndex(value => value.cleanup);
  expect(owner).toBeGreaterThanOrEqual(0);
  expect(saved).toBeGreaterThan(owner);
  expect(dispatched).toBeGreaterThan(saved);
  expect(cleaned).toBeGreaterThan(dispatched);
  expect(f.trace.filter(value => value.cleanup)).toEqual([{ cleanup: f.terminalId }]);
});

test("invalid reserved identity cannot fall back to a generated UUID", async () => {
  for (const reservation of [{ terminalId: "" }, {}, { terminalId: "bad" }]) {
    const f = fixture();
    await expect(f.manager.create(f.input, undefined, undefined, reservation as never)).rejects.toThrow("UUID");
    expect(f.trace).toEqual([]);
  }
});


test("reserved owner is revalidated after asynchronous server preparation before any pane dispatch", async () => {
  const f = fixture();
  let checked = 0;
  (f.manager as any).prepareServer = async () => { await Promise.resolve(); };
  await expect(f.manager.create(f.input, undefined, undefined, { terminalId: f.terminalId, validateOwner() { checked++; throw new Error("owner changed"); } })).rejects.toThrow("owner changed");
  expect(checked).toBe(1); expect(f.trace).toEqual([]);
});
