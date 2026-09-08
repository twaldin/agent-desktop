import { afterEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { createDockState, resizeDock, dockTabId, insertDockTab, moveDockTab, MAX_WORKSPACE_FILE_PATH_LENGTH, standaloneFileDockTarget } from "../renderer/dock-state";
import { persistentFileTabs } from "../renderer/file-preview-tabs";
import {
  defaultWindowView,
  parseDockSnapshot,
  parseWindowView,
} from "../window-state";
import {
  restoreWindowBounds,
  trackWindowGeometry,
  WindowStateStore,
} from "./window-state";
const directories: string[] = [];
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-window-state-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const selected = () => ({
  ...defaultWindowView(),
  route: { hostId: "offline-machine", sessionId: "saved-session" },
  sidebarOpen: false,
  terminalOpen: true,
  workspaceOpen: true,
  workspaceTab: "changes" as const,
  expandedProjects: ["offline-machine:project-one"],
});

test("restart restores local route/layout and normal bounds without storing arbitrary payloads", () => {
  const directory = temporary(),
    store = new WindowStateStore(directory, "primary"),
    state = selected();
  expect(
    store.saveView({
      ...state,
      text: "PRIVATE DRAFT",
      token: "PRIVATE TOKEN",
      route: { ...state.route, cwd: "/private/path" },
    }),
  ).toEqual({});
  const normal = { x: 91, y: 41, width: 1200, height: 820 };
  expect(store.saveGeometry(normal, true)).toEqual({});
  const restarted = new WindowStateStore(directory, "primary");
  expect(restarted.bootstrap()).toEqual({ state });
  expect(restarted.geometry()).toEqual({ bounds: normal, maximized: true });
  expect(statSync(store.file).mode & 0o777).toBe(0o600);
  const raw = readFileSync(store.file, "utf8");
  expect(raw).not.toContain("PRIVATE");
  expect(raw).not.toContain("cwd");
  const copy = restarted.bootstrap().state!;
  copy.route.hostId = "changed-copy";
  expect(restarted.bootstrap().state?.route.hostId).toBe("offline-machine");
  expect(readdirSync(directory)).toEqual(["window-primary-v1.json"]);
});

test("separate profiles and simultaneous window slots cannot overwrite each other", () => {
  const first = temporary(),
    second = temporary(),
    a = new WindowStateStore(first, "primary"),
    b = new WindowStateStore(first, "second"),
    c = new WindowStateStore(second, "primary");
  a.saveView(selected());
  b.saveView({
    ...selected(),
    route: { hostId: "second-machine", sessionId: null },
  });
  c.saveView(defaultWindowView());
  a.saveGeometry({ x: 0, y: 0, width: 900, height: 600 }, false);
  expect(new WindowStateStore(first, "primary").bootstrap().state).toEqual(
    selected(),
  );
  expect(
    new WindowStateStore(first, "second").bootstrap().state?.route,
  ).toEqual({ hostId: "second-machine", sessionId: null });
  expect(new WindowStateStore(second, "primary").bootstrap().state).toEqual(
    defaultWindowView(),
  );
  expect(() => new WindowStateStore(first, "../primary")).toThrow(
    "Invalid local window slot",
  );
});

test("invalid, oversized and symlinked saves produce visible startup errors without following the link", () => {
  const directory = temporary(),
    file = join(directory, "window-primary-v1.json");
  for (const raw of [
    "{broken",
    JSON.stringify({ version: 9 }),
    JSON.stringify({
      version: 1,
      view: { ...selected(), terminalOpen: "true" },
    }),
    " ".repeat(512 * 1024 + 1),
  ]) {
    writeFileSync(file, raw);
    const store = new WindowStateStore(directory, "primary");
    expect(store.bootstrap().error).toContain("could not be read");
    expect(store.bootstrap().state).toBeUndefined();
    expect(
      store.saveGeometry({ x: 0, y: 0, width: 900, height: 600 }, false),
    ).toEqual({});
    expect(store.bootstrap().error).toContain("could not be read");
  }
  rmSync(file);
  const target = join(directory, "unrelated.json");
  writeFileSync(target, JSON.stringify({ version: 1, view: selected() }));
  symlinkSync(target, file);
  const store = new WindowStateStore(directory, "primary");
  expect(store.bootstrap().state).toBeUndefined();
  expect(store.bootstrap().error).toBeTruthy();
  expect(store.saveView(defaultWindowView())).toEqual({});
  expect(JSON.parse(readFileSync(target, "utf8")).view).toEqual(selected());
});

test("failed atomic save preserves acknowledged state, reports failure and leaves no staging files", () => {
  const directory = temporary(),
    store = new WindowStateStore(directory, "primary");
  store.saveView(selected());
  rmSync(store.file);
  mkdirSync(store.file);
  const result = store.saveView(defaultWindowView());
  expect(result.error).toContain("could not be saved");
  expect(store.bootstrap().state).toEqual(selected());
  expect(store.bootstrap().error).toBe(result.error);
  expect(readdirSync(directory)).toEqual(["window-primary-v1.json"]);
  rmSync(store.file, { recursive: true });
  expect(store.saveView(defaultWindowView())).toEqual({});
  expect(new WindowStateStore(directory, "primary").bootstrap()).toEqual({
    state: defaultWindowView(),
  });
});

test("bounded validation rejects malformed routes, unbounded lists, invalid geometry and reserved data", () => {
  expect(
    parseWindowView({
      ...selected(),
      route: { hostId: "https://remote", sessionId: null },
    }),
  ).toBeUndefined();
  expect(
    parseWindowView({
      ...selected(),
      expandedProjects: Array(1001).fill("a:b"),
    }),
  ).toBeUndefined();
  expect(
    parseWindowView({ ...selected(), expandedProjects: ["a:b", "a:b"] })
      ?.expandedProjects,
  ).toEqual(["a:b"]);
  const store = new WindowStateStore(temporary(), "primary");
  expect(
    store.saveGeometry({ x: 0, y: 0, width: 100, height: 480 }, false).error,
  ).toBeTruthy();
  expect(
    store.saveView({ ...selected(), settingsPage: "credentials" }).error,
  ).toBeTruthy();
});

test("dock restoration retains offline owners and native terminal identity", () => {
  const files = {
    id: "offline-machine:project:project-one:files",
    title: "Files",
    hostId: "offline-machine",
    target: "project:project-one",
    kind: "files",
  } as const;
  const terminal = {
    id: "offline-machine:session:saved-session:terminal:terminal-one",
    title: "Shell",
    hostId: "offline-machine",
    target: "session:saved-session",
    kind: "terminal",
    terminalId: "terminal-one",
  } as const;
  const dock = {
    tabs: [files, terminal],
    state: {
      right: { tabIds: [files.id], activeTabId: files.id, open: true },
      bottom: { tabIds: [terminal.id], activeTabId: terminal.id, open: false },
      rightWidthRatio: 0.375,
      bottomHeight: 288,
    },
  };
  const parsed = parseWindowView({
    ...selected(),
    dock,
    environmentOpen: true,
  });
  expect(parsed?.route).toEqual({
    hostId: "offline-machine",
    sessionId: "saved-session",
  });
  expect(parsed?.dock).toEqual(dock);
  expect(parsed?.environmentOpen).toBe(true);

  const directory = temporary(),
    store = new WindowStateStore(directory, "primary");
  store.saveView(parsed);
  expect(
    new WindowStateStore(directory, "primary").bootstrap().state?.dock,
  ).toEqual(dock);
});

test("legacy views restore while malformed dock descriptors are discarded without changing navigation", () => {
  expect(parseWindowView(selected())).toEqual(selected());
  const valid = {
    tabs: [
      {
        id: "owner:project:project:files",
        title: "Files",
        hostId: "owner",
        target: "project:project",
        kind: "files",
      },
    ],
    state: {
      right: {
        tabIds: ["owner:project:project:files"],
        activeTabId: "owner:project:project:files",
        open: true,
      },
      bottom: { tabIds: [], open: false },
      rightWidthRatio: 0.3,
      bottomHeight: 240,
    },
  };
  const malformed = [
    {
      ...valid,
      tabs: [
        {
          ...valid.tabs[0],
          hostId: "https://owner",
          id: "https://owner:project:project:files",
        },
      ],
    },
    { ...valid, tabs: [{ ...valid.tabs[0], terminalId: "wrong-kind" }] },
    {
      ...valid,
      tabs: [
        {
          ...valid.tabs[0],
          kind: "terminal",
          id: "owner:project:project:terminal",
        },
      ],
    },
    {
      ...valid,
      tabs: [
        {
          ...valid.tabs[0],
          kind: "terminal",
          terminalId: "bad/id",
          id: "owner:project:project:terminal:bad/id",
        },
      ],
    },
    {
      ...valid,
      state: {
        ...valid.state,
        bottom: {
          tabIds: [...valid.state.right.tabIds],
          activeTabId: valid.state.right.activeTabId,
          open: true,
        },
      },
    },
    { ...valid, state: { ...valid.state, rightWidthRatio: Number.NaN } },
    {
      ...valid,
      state: { ...valid.state, bottomHeight: Number.POSITIVE_INFINITY },
    },
  ];
  for (const dock of malformed) {
    expect(parseDockSnapshot(dock)).toBeUndefined();
    expect(parseWindowView({ ...selected(), dock })?.route).toEqual(
      selected().route,
    );
  }
  expect(
    parseWindowView({ ...selected(), environmentOpen: "yes" }),
  ).toBeUndefined();
});

test("monitor restoration clamps offscreen titlebars and keeps normal geometry on the matching monitor", () => {
  const main = { x: 0, y: 24, width: 1440, height: 876 },
    side = { x: -1920, y: 24, width: 1920, height: 1056 };
  expect(
    restoreWindowBounds({ x: -1800, y: 30, width: 1200, height: 820 }, [
      main,
      side,
    ]),
  ).toEqual({ x: -1800, y: 30, width: 1200, height: 820 });
  expect(
    restoreWindowBounds({ x: -3000, y: -900, width: 2000, height: 1500 }, [
      main,
    ]),
  ).toEqual({ x: 0, y: 24, width: 1440, height: 876 });
});

test("native close flushes a pending geometry change and geometry write failures are observable", () => {
  const directory = temporary(),
    store = new WindowStateStore(directory, "primary"),
    events = new EventEmitter();
  const geometry = { x: 21, y: 31, width: 1100, height: 750 },
    notifications: { error?: string }[] = [];
  const window = Object.assign(events, {
    isDestroyed: () => false,
    getNormalBounds: () => geometry,
    isMaximized: () => true,
  }) as unknown as BrowserWindow;
  trackWindowGeometry(window, store, (value) => notifications.push(value));
  events.emit("move");
  events.emit("close");
  expect(new WindowStateStore(directory, "primary").geometry()).toEqual({
    bounds: geometry,
    maximized: true,
  });
  expect(notifications).toEqual([{}]);
  rmSync(store.file);
  mkdirSync(store.file);
  events.emit("resize");
  events.emit("close");
  expect(notifications.at(-1)?.error).toContain("could not be saved");
  events.emit("closed");
});

// Narrow resize can legitimately reach zero available side width. Restoring
// that presentation must retain every tab; renderer clamping handles visibility.
test("a dock resized below the minimum main width still round-trips its tab identity", () => {
  const tab = {
    id: "owner:project:project:files",
    title: "Files",
    hostId: "owner",
    target: "project:project" as const,
    kind: "files" as const,
  };
  const state = createDockState();
  state.right = { open: true, tabIds: [tab.id], activeTabId: tab.id };
  const resized = resizeDock(state, "right", 300, { width: 300, height: 600 });
  expect(resized.rightWidthRatio).toBe(0);
  expect(
    parseDockSnapshot(
      JSON.parse(JSON.stringify({ state: resized, tabs: [tab] })),
    )?.tabs,
  ).toEqual([tab]);
});
test("browser target persistence accepts native names and retains legacy browser plus other panes", () => {
  const generic = {
    id: "owner:session:s:browser",
    title: "Browser",
    hostId: "owner",
    target: "session:s" as const,
    kind: "browser" as const,
  };
  const exact = {
    id: "owner:session:s:browser:target=17%00tab%20with%20spaces%00target%2Fwith%3Apunctuation",
    title: "Native",
    hostId: "owner",
    target: "session:s" as const,
    kind: "browser" as const,
    browserTarget: {
      workerPid: 17,
      name: "tab with spaces",
      targetId: "target/with:punctuation",
    },
  };
  const files = {
    id: "owner:project:p:files",
    title: "Files",
    hostId: "owner",
    target: "project:p" as const,
    kind: "files" as const,
  };
  const terminal = {
    id: "owner:project:p:terminal:t",
    title: "Terminal",
    hostId: "owner",
    target: "project:p" as const,
    kind: "terminal" as const,
    terminalId: "t",
  };
  const state = createDockState();
  state.right = {
    open: true,
    tabIds: [generic.id, exact.id, files.id],
    activeTabId: exact.id,
  };
  state.bottom = {
    open: true,
    tabIds: [terminal.id],
    activeTabId: terminal.id,
  };
  expect(
    parseDockSnapshot({ state, tabs: [generic, exact, files, terminal] })?.tabs,
  ).toEqual([generic, exact, files, terminal]);
});

test("Git and environment settings reopen without changing the saved host, conversation or docks", () => {
  const directory = temporary();
  for (const settingsPage of ["git", "environments"] as const) {
    const state = { ...selected(), settingsOpen: true, settingsPage };
    const store = new WindowStateStore(directory, "primary");
    expect(store.saveView(state)).toEqual({});
    expect(new WindowStateStore(directory, "primary").bootstrap().state).toEqual(state);
  }
});

test("side-chat layout survives restart with its offline session owner and unread state", () => {
  const tab = { id: "offline-machine:session:saved-session:side-chat", title: "Explain the previous change", hostId: "offline-machine", target: "session:saved-session", kind: "side-chat", unread: true } as const;
  const dock = { tabs: [tab], state: { ...createDockState(), right: { tabIds: [tab.id], activeTabId: tab.id, open: true } } };
  const directory = temporary();
  new WindowStateStore(directory, "primary").saveView({ ...selected(), dock });
  expect(new WindowStateStore(directory, "primary").bootstrap().state?.dock).toEqual(dock);
  const invalid = { ...tab, target: "project:saved-session", id: "offline-machine:project:saved-session:side-chat" };
  expect(parseDockSnapshot({ tabs: [invalid], state: { ...dock.state, right: { tabIds: [invalid.id], activeTabId: invalid.id, open: true } } })).toBeUndefined();
});

test("skill file dock restoration preserves host-native scope and rejects conflicting identities", () => {
  const skillFile = {skillId:"skill:sample",sourcePath:"/outside-project/SKILL.md",inventory:true};
  const descriptor = {kind:"skill-file" as const,hostId:"work",target:"host" as const,title:"SKILL.md",skillFile};
  const tab = {...descriptor,id:dockTabId(descriptor)};
  const snapshot = {state:insertDockTab(createDockState(),tab,"right"),tabs:[tab]};
  expect(parseDockSnapshot(snapshot)).toEqual(snapshot);
  const changed=(patch:Record<string,unknown>)=>({...snapshot,tabs:[{...tab,...patch}]});
  expect(parseDockSnapshot(changed({skillFile:undefined}))).toBeUndefined();
  expect(parseDockSnapshot(changed({kind:"files"}))).toBeUndefined();
  expect(parseDockSnapshot(changed({target:"project:p"}))).toBeUndefined();
  expect(parseDockSnapshot(changed({skillFile:{...skillFile,target:{projectId:"p"}}}))).toBeUndefined();
  expect(parseDockSnapshot(changed({skillFile:{...skillFile,sourcePath:"/another/SKILL.md"}}))).toBeUndefined();
  expect(parseDockSnapshot(changed({skillFile:{...skillFile,content:"must not persist in window state"}}))).toBeUndefined();
});

test("workspace file docks move and restore with their exact path", () => {
  const descriptor = { kind: "file" as const, hostId: "offline-machine", target: "project:project-one" as const, title: "a file.ts", filePath: "src/a file.ts" };
  const tab = { ...descriptor, id: dockTabId(descriptor) };
  let state = insertDockTab(createDockState(), tab, "right");
  state = moveDockTab(state, tab.id, "bottom");
  const dock = { state, tabs: [tab] };
  expect(parseDockSnapshot(JSON.parse(JSON.stringify(dock)))).toEqual(dock);
  const directory = temporary();
  const store = new WindowStateStore(directory, "primary");
  expect(store.saveView({ ...selected(), dock })).toEqual({});
  expect(new WindowStateStore(directory, "primary").bootstrap().state?.dock).toEqual(dock);
});

test("disk restoration omits unpinned file previews and retains the promoted file route", () => {
  const descriptor = {kind:"file" as const,hostId:"owner",target:"session:s" as const,title:"preview.ts",filePath:"preview.ts"};
  const preview = {...descriptor,id:dockTabId(descriptor),preview:true as const};
  const state = insertDockTab(createDockState(),preview,"right");
  const directory = temporary(), store = new WindowStateStore(directory,"file-preview");
  expect(store.saveView({...selected(),dock:persistentFileTabs({state,tabs:[preview]})})).toEqual({});
  expect(new WindowStateStore(directory,"file-preview").bootstrap().state?.dock).toMatchObject({tabs:[],state:{right:{tabIds:[],open:true}}});
  // A caller accidentally serializing a live snapshot cannot turn a preview into a permanent tab.
  expect(parseDockSnapshot({state,tabs:[preview]})).toBeUndefined();
  const {preview:_preview,...pinned}=preview;
  expect(store.saveView({...selected(),dock:{state,tabs:[pinned]}})).toEqual({});
  expect(new WindowStateStore(directory,"file-preview").bootstrap().state?.dock?.tabs).toEqual([pinned]);
});

test("workspace file persistence rejects invalid paths and owners", () => {
  const descriptor = { kind: "file" as const, hostId: "owner", target: "project:p" as const, title: "file.ts", filePath: "src/file.ts" };
  const tab = { ...descriptor, id: dockTabId(descriptor) };
  const snapshot = { state: insertDockTab(createDockState(), tab, "right"), tabs: [tab] };
  const changed = (patch: Record<string, unknown>) => {
    const changedTab = { ...tab, ...patch };
    return { ...snapshot, tabs: [changedTab], state: { ...snapshot.state, right: { ...snapshot.state.right, tabIds: [String(changedTab.id)], activeTabId: String(changedTab.id) } } };
  };
  for (const filePath of [undefined, "", "/absolute.ts", "src//file.ts", "src/./file.ts", "src/../file.ts", "src\\file.ts", "src/\0file.ts", `a${"b".repeat(MAX_WORKSPACE_FILE_PATH_LENGTH)}`])
    expect(parseDockSnapshot(changed({ filePath }))).toBeUndefined();
  expect(parseDockSnapshot(changed({ hostId: "https://owner" }))).toBeUndefined();
  expect(parseDockSnapshot(changed({ target: "host" }))).toBeUndefined();
  expect(parseDockSnapshot(changed({ kind: "files" }))).toBeUndefined();
});

test("standalone file docks retain the absolute identity only through their target", () => {
  const target = standaloneFileDockTarget("/outside project/a file.ts");
  const descriptor = { kind: "file" as const, hostId: "owner", target, title: "a file.ts", filePath: "a file.ts" };
  const tab = { ...descriptor, id: dockTabId(descriptor) };
  const snapshot = { state: insertDockTab(createDockState(), tab, "right"), tabs: [tab] };
  expect(parseDockSnapshot(snapshot)).toEqual(snapshot);
  const changed = (patch: Record<string, unknown>) => {
    const changedTab = { ...tab, ...patch };
    return { ...snapshot, tabs: [changedTab], state: { ...snapshot.state, right: { ...snapshot.state.right, tabIds: [String(changedTab.id)], activeTabId: String(changedTab.id) } } };
  };
  expect(parseDockSnapshot(changed({ filePath: "other.ts" }))).toBeUndefined();
  expect(parseDockSnapshot(changed({ target: "file:%2Foutside%2F..%2Fsecret", id: tab.id }))).toBeUndefined();
  expect(parseDockSnapshot(changed({ kind: "files" }))).toBeUndefined();
});

test("file-tree visibility belongs to the window while renderer width is not persisted", () => {
  const directory = temporary();
  const primary = new WindowStateStore(directory, "primary"), second = new WindowStateStore(directory, "secondary");
  expect(primary.saveView({ ...selected(), fileTreeOpen: true })).toEqual({});
  expect(second.saveView({ ...selected(), fileTreeOpen: false })).toEqual({});
  expect(new WindowStateStore(directory, "primary").bootstrap().state?.fileTreeOpen).toBe(true);
  expect(new WindowStateStore(directory, "secondary").bootstrap().state?.fileTreeOpen).toBe(false);
  const parsed = parseWindowView({ ...selected(), fileTreeOpen: true, fileTreeWidth: 9000 });
  expect(parsed?.fileTreeOpen).toBe(true); expect(parsed).not.toHaveProperty("fileTreeWidth");
  expect(parseWindowView({ ...selected(), fileTreeOpen: "true" })?.fileTreeOpen).toBeUndefined();
});

test("Markdown mode persists with the exact owning file tab and ignores invalid presentation values", () => {
  const descriptor = { kind: "file" as const, hostId: "owner", target: "project:p" as const, title: "README.md", filePath: "README.md" };
  const source = { ...descriptor, id: dockTabId(descriptor), fileMode: "source" as const };
  const markdown = { ...source, fileMode: "markdown" as const };
  const state = insertDockTab(createDockState(), source, "right");
  const directory = temporary(), store = new WindowStateStore(directory, "primary");
  for (const tab of [source, markdown]) {
    store.saveView({ ...selected(), dock: { state, tabs: [tab] } });
    expect(new WindowStateStore(directory, "primary").bootstrap().state?.dock?.tabs[0]).toEqual(tab);
  }
  expect(parseDockSnapshot({ state, tabs: [{ ...source, fileMode: "html" }] })?.tabs[0]).toEqual({ ...descriptor, id: source.id });
  expect(dockTabId(source)).toBe(dockTabId(markdown));
});

test("skill source mode survives disk restoration per window without sharing file contents", () => {
  const directory=temporary();
  for(const target of [undefined,{projectId:"p"},{sessionId:"s"}]){
    const descriptor={kind:"skill-file" as const,hostId:"work",target:(!target?"host":"projectId" in target?"project:p":"session:s") as "host"|"project:p"|"session:s",title:"SKILL.md",skillFile:{skillId:"skill:sample",sourcePath:"/native/SKILL.md",inventory:true,...(target?{target}:{})}};
    const tab={...descriptor,id:dockTabId(descriptor),fileMode:"source" as const};
    const state=insertDockTab(createDockState(),tab,"right");
    new WindowStateStore(directory,"source-window").saveView({...selected(),dock:{state,tabs:[tab]}});
    new WindowStateStore(directory,"preview-window").saveView({...selected(),dock:{state,tabs:[{...tab,fileMode:"markdown"}]}});
    expect(new WindowStateStore(directory,"source-window").bootstrap().state?.dock?.tabs[0]).toEqual(tab);
    expect(new WindowStateStore(directory,"preview-window").bootstrap().state?.dock?.tabs[0]?.fileMode).toBe("markdown");
    expect(parseDockSnapshot({state,tabs:[{...tab,fileMode:"invalid"}]})?.tabs[0]).not.toHaveProperty("fileMode");
    expect(parseDockSnapshot({state,tabs:[{...tab,fileMode:undefined}]})?.tabs[0]).not.toHaveProperty("fileMode");
    const preview={...tab,fileMode:"markdown" as const};expect(dockTabId(preview)).toBe(tab.id);
  }
});

test("file scroll fallback is bounded, mode-specific, owner-bound and window-local", () => {
  const descriptor = { kind: "skill-file" as const, hostId: "remote", target: "host" as const, title: "SKILL.md",
    skillFile: { skillId: "skill", sourcePath: "/skills/example/SKILL.md", inventory: true } };
  const tab = { ...descriptor, id: dockTabId(descriptor), fileScroll: { markdown: 412.5, source: 918 } };
  const dock = { tabs: [tab], state: insertDockTab(createDockState(), tab, "right") };
  const root = temporary(), store = new WindowStateStore(root, "one");
  expect(store.saveView({ ...defaultWindowView(), dock })).toEqual({});
  expect(new WindowStateStore(root, "one").bootstrap().state?.dock?.tabs[0]?.fileScroll).toEqual(tab.fileScroll);
  expect(new WindowStateStore(root, "two").bootstrap().state?.dock).toBeUndefined();
  for (const top of [-1, NaN, Infinity, 100_000_001, "400", null]) {
    expect(parseDockSnapshot({ ...dock, tabs: [{ ...tab, fileScroll: { markdown: top } }] })).toBeUndefined();
  }
  expect(parseDockSnapshot({ ...dock, tabs: [{ ...tab, fileScroll: { source: 0, content: "PRIVATE RAW", effect: {} } }] })?.tabs[0]?.fileScroll).toEqual({ source: 0 });
  expect(parseDockSnapshot({ ...dock, tabs: [{ ...tab, hostId: "other" }] })).toBeUndefined();
});
