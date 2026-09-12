import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { TerminalCreationBridge } from "@agent-desktop/shared";
import type { TerminalWindowIntent } from "../terminal-window-intent";
import { defaultWindowView } from "../window-state";
import { createBrowserNewTab } from "./browser-new-tab";
import { createDockState, insertDockTab, type DockTab } from "./dock-state";
import { reconcileDockPresentations } from "./dock-presentations";
import { captureBrowserReplacement } from "./browser-workspace-replacement";
import { admitBrowserReplacement, acknowledgeBrowserAdmissions, type BrowserReplacementPresentations } from "./browser-replacement-admission";
import { BrowserWorkspaceMenu } from "./browser-workspace-menu";
import { TerminalWindowOwner } from "./terminal-window-owner";

const hostId = "10000000-0000-4000-8000-000000000001", sessionId = "20000000-0000-4000-8000-000000000002";
const terminalId = "30000000-0000-4000-8000-000000000003", epoch = "40000000-0000-4000-8000-000000000004";
const app = readFileSync(process.env.TERMINAL_ADMISSION_APP_SOURCE ?? new URL("./App.tsx", import.meta.url), "utf8");
const start = app.indexOf("onCheck={button => {", app.indexOf("function terminalRecovery("));
const end = app.indexOf("}}/>;", start);
if (start < 0 || end < start) throw new Error("Actual App terminal recovery handler missing");
const expression = app.slice(start + "onCheck={".length, end + 1);
const code = new Bun.Transpiler({ loader: "ts" }).transformSync(`function handler(values) {
  const { terminalRequests, browserMenu, intent, requestKey, detached, defaultTerminalLocation, workbenchElement, dock, captureBrowserReplacement } = values;
  return (${expression});
}`);
const handler = new Function(`${code}; return handler;`)() as (values: Record<string, unknown>) => (button: HTMLButtonElement) => void;
const drain = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

/** Actual App callback, window owner, menu and queued admission. Context and
 * commit notifications are controlled, not a mounted React or native test. */
function fixture(detached = false) {
  const source = { ...createBrowserNewTab(hostId, sessionId, "source"), browserNewTab: { status: "idle" as const, draft: "original address" } };
  const intent: TerminalWindowIntent = { version: 1, hostId,
    source: { kind: "browser", tabId: source.id, browserInstanceId: source.browserInstanceId!, title: source.title, draft: source.browserNewTab.draft },
    request: { version: 1, requestId: "50000000-0000-4000-8000-000000000005", controlEpoch: epoch, target: { sessionId }, cols: 120, rows: 30 } };
  let presentations: BrowserReplacementPresentations = reconcileDockPresentations(undefined,
    detached ? {tabs:[],state:createDockState()} : { tabs: [source], state: insertDockTab(createDockState(), source, "right") }, "initial");
  const calls: string[] = [], queue: Array<() => void> = [];
  const bridge: TerminalCreationBridge = {
    async getTerminalCreationCapabilities() { calls.push("capabilities"); throw new Error("No acquisition during recovery"); },
    async createNativeTerminal() { calls.push("create"); throw new Error("No replay during recovery"); },
    async observeTerminalCreation(request, ownerHost) {
      calls.push("inspect"); expect(request).toEqual(intent.request); expect(ownerHost).toBe(hostId);
      return { ok: true, value: { version: 1, hostId, requestId: request.requestId, status: "settled", receipt: { outcome: "completed", terminalId },
        terminal: { id: terminalId, target: request.target, cwd: "/fixture", protocol: "tmux-v1", serverGeneration: epoch, status: "running", attachable: true } } };
    },
  };
  const owner = new TerminalWindowOwner(bridge, [intent], () => {}), menu = new BrowserWorkspaceMenu(() => {});
  const requestedGuards: Array<{requestKey:string;detached:boolean}> = [];
  const recoveryGuard=owner.recoveryAttachmentGuard.bind(owner);
  owner.recoveryAttachmentGuard=(requestKey,toDock=false)=>{requestedGuards.push({requestKey,detached:toDock});return recoveryGuard(requestKey,toDock);};
  let connected = true, count = 0;
  const mainChat = { kind: "chat" as const, hostId, sessionId };
  function commit() {
    owner.commit({ hostId, target: { sessionId }, connected, enabled: true, presentations });
    menu.commit({ presentations, owner: mainChat, connected, enabled: true, actions: [], chatTitle: "Chat",
      replace(origin, destination, readOwner) {
        const id = `admission-${++count}`;
        queue.push(() => { presentations = admitBrowserReplacement(presentations, origin, destination, readOwner(), id); });
        return id;
      } });
  }
  const button = { isConnected: true } as HTMLButtonElement;
  const document = { activeElement: button, body: {} };
  Object.assign(button, { ownerDocument: document });
  const workbenchElement = { current: { isConnected: true, contains: (node: unknown) => node === button } };
  function check() {
    handler({ terminalRequests: owner, browserMenu: menu, intent, requestKey: `${hostId}:${intent.request.requestId}`, detached,
      defaultTerminalLocation: "bottom", workbenchElement, captureBrowserReplacement,
      dock: { publishTerminal(tab:DockTab,destination:"right"|"bottom",guard:()=>boolean) {
        if(!detached)throw new Error("Browser result must use browser admission");
        queue.push(()=>{if(guard())presentations=reconcileDockPresentations(presentations,
          {tabs:[...presentations.snapshot.tabs,tab],state:insertDockTab(presentations.snapshot.state,tab,destination)},"published");});
      } } })(button);
  }
  function view() { return { ...defaultWindowView(), route: { hostId, sessionId }, dock: presentations.snapshot, terminalCreations: owner.intents }; }
  function flush() {
    while (queue.length) queue.shift()!();
    commit(); owner.committed(view());
    const results = menu.committed(presentations.browserAdmissions);
    presentations = acknowledgeBrowserAdmissions(presentations, [...presentations.browserAdmissions?.keys() ?? []]); commit();
    return results;
  }
  commit();
  return { source, intent, owner, menu, calls, queue, requestedGuards, check, flush, view,
    get presentations() { return presentations; },
    connection(value: boolean) { connected = value; commit(); },
    dispose() { owner.dispose(); menu.dispose(); } };
}

test("App recovery retains its connection guard through queued browser admission and requires a fresh check after reconnect", async () => {
  const f = fixture();
  try {
    f.check(); await drain(); expect(f.queue).toHaveLength(1); expect(f.calls).toEqual(["inspect"]);
    f.connection(false); f.connection(true);
    expect(f.flush()).toEqual([]);
    expect(f.presentations.snapshot.tabs).toEqual([f.source]); expect(f.source.browserNewTab.draft).toBe("original address");
    expect(f.owner.intents).toEqual([f.intent]); f.owner.saved(f.view()); expect(f.owner.intents).toEqual([f.intent]);
    expect(f.calls).toEqual(["inspect"]); expect(f.menu.state(f.presentations.instances.get(f.source.id)!)).toBeUndefined();
    f.check(); await drain(); expect(f.queue).toHaveLength(1);
    expect(f.flush()).toHaveLength(1); expect(f.presentations.snapshot.tabs).toHaveLength(1);
    expect(f.presentations.snapshot.tabs[0]).toMatchObject({ kind: "terminal", terminalId });
    expect(f.owner.intents).toEqual([]); expect(f.calls).toEqual(["inspect", "inspect"]);
  } finally { f.dispose(); }
});

test("App recovery admits the original result across repeated connected commits without another acquisition", async () => {
  const f = fixture();
  try {
    f.check(); await drain(); expect(f.queue).toHaveLength(1);
    f.connection(true); f.connection(true);
    expect(f.flush()).toHaveLength(1); expect(f.presentations.snapshot.tabs[0]).toMatchObject({ kind: "terminal", terminalId });
    expect(f.owner.intents).toEqual([]); expect(f.calls).toEqual(["inspect"]);
  } finally { f.dispose(); }
});

test("App detached recovery requests the saved-owner guard and retains it through queued dock publication",async()=>{
  const f=fixture(true);
  try{
    const expected={requestKey:`${hostId}:${f.intent.request.requestId}`,detached:true};
    f.check();await drain();expect(f.requestedGuards).toEqual([expected]);expect(f.queue).toHaveLength(1);
    expect(f.owner.intents).toEqual([f.intent]);expect(f.presentations.snapshot.tabs).toEqual([]);
    f.connection(false);f.connection(true);f.flush();
    expect(f.presentations.snapshot.tabs).toEqual([]);expect(f.owner.intents).toEqual([f.intent]);
    f.check();await drain();expect(f.requestedGuards).toEqual([expected,expected]);f.flush();
    expect(f.presentations.snapshot.tabs).toHaveLength(1);expect(f.presentations.snapshot.tabs[0]).toMatchObject({kind:"terminal",terminalId});
    expect(f.presentations.snapshot.state.bottom.activeTabId).toBe(f.presentations.snapshot.tabs[0]!.id);
    expect(f.owner.intents).toEqual([]);expect(f.calls).toEqual(["inspect","inspect"]);
  }finally{f.dispose();}
});
