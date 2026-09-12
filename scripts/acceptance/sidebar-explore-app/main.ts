import { app, BrowserWindow, Menu, ipcMain } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requestHost } from "../../../apps/desktop/src/main/host-transport";
import { requestVersionedCommand } from "../../../apps/desktop/src/main/command-endpoints";
import { readPullRequests } from "../../../apps/desktop/src/main/pull-requests-transport";
import { listAutomations } from "../../../apps/desktop/src/main/automations-transport";
import { requestMarketplaceCatalog } from "../../../apps/desktop/src/main/plugin-acquisition-transport";
import { WindowStateStore } from "../../../apps/desktop/src/main/window-state";
import { defaultWindowView } from "../../../apps/desktop/src/window-state";
const [output, fixture] = process.argv.slice(2) as [string, string];
const connection = JSON.parse(readFileSync(join(fixture, "connection.json"), "utf8"));
const context = JSON.parse(readFileSync(join(fixture, "context.json"), "utf8"));
app.setPath("userData", join(fixture, "sidebar-explore-electron"));
app.setName("Sidebar Explore Isolated Acceptance");
app.on("window-all-closed", () => { /* This acceptance deliberately reopens its owned window. */ });
const store = new WindowStateStore(join(fixture, "sidebar-explore-window"), "sidebar-explore-app");
if (!store.bootstrap().state) store.saveView({ ...defaultWindowView(), route: { hostId: connection.hostId, sessionId: null }, workspaceOpen: false });
const calls: unknown[] = [], inputs: unknown[] = [], captures: unknown[] = [], errors: unknown[] = [], checkpoints: string[] = [];
let window: BrowserWindow, capability = true, preferenceCapability = true, writeFailure: "rejected" | "lost" | undefined;
const http = (path: string, body?: unknown) => requestHost(connection, path, body);
const state = async () => { const value = await http("/v1/state") as any; if (!capability) delete value.pullRequests; if (!preferenceCapability) delete value.sidebarNavigation; return value; };
const emit = (event: unknown) => { if (window && !window.isDestroyed()) window.webContents.send("sidebar-explore-app-event", event); };
const invalidate = async () => emit({ type: "state", state: await state(), hostId: connection.hostId });
ipcMain.on("sidebar-explore-app-save", (event, value) => { event.returnValue = store.saveView(value); });
ipcMain.handle("sidebar-explore-app-call", async (_event, method: string, args: any[] = []) => {
  calls.push({ method, args });
  switch (method) {
    case "bootstrap": return store.bootstrap();
    case "getState": return state();
    case "getHosts": return http("/v1/peers");
    case "getPreferences": return http("/v1/preferences");
    case "getPreferencesV2": return { ok: true, value: await http("/v2/preferences") };
    case "getTheme": return http("/v1/theme");
    case "getComposerCatalog": return http("/v1/models/composer", { target: args[0], refresh: args[1] });
    case "getMessages": return http(`/v1/sessions/${encodeURIComponent(args[0])}/messages`);
    case "getInteractions": return http(`/v1/sessions/${encodeURIComponent(args[0])}/interactions`);
    case "getSessionControls": return http(`/v1/sessions/${encodeURIComponent(args[0])}/controls`);
    case "workspaceQuery": return http("/v1/workspace/query", { target: args[0], query: args[1] });
    case "getBtw": return http(`/v1/sessions/${encodeURIComponent(args[0])}/btw`);
    case "getComposerActions": return http("/v1/composer/actions", { target: args[0], refresh: args[1] });
    case "getComposerCompletions": return http("/v1/composer/completions", args[0]);
    case "getPlugins": return http("/v1/integrations/plugins/read", { target: args[0] });
    case "getMarketplaceCatalog": return requestMarketplaceCatalog(connection, args[0]);
    case "pullRequests": if (args[0] !== connection.hostId) throw new Error("Foreign owner"); return readPullRequests(connection, args[1]);
    case "automations": if (args[0] !== connection.hostId) throw new Error("Foreign owner"); return listAutomations(connection, args[1]);
    case "mutateAutomation": throw new Error("Automation mutation is outside sidebar acceptance.");
    case "command": {
      const envelope = args[0];
      if (args[1] !== connection.hostId) throw new Error("Foreign command owner");
      if (envelope.command.type === "session.prompt") throw new Error("Provider prompts are forbidden.");
      if (envelope.command.type === "preferences.put" && envelope.command.change.key === "sidebar.navigation") {
        if (writeFailure === "rejected") { writeFailure = undefined; return { ok: false, commandId: envelope.id, error: { code: "DENIED", message: "Controlled sidebar write rejection" } }; }
        const result = await requestVersionedCommand(http, envelope);
        if (writeFailure === "lost") { writeFailure = undefined; throw new Error("Controlled lost sidebar receipt"); }
        return result;
      }
      return requestVersionedCommand(http, envelope);
    }
    default: throw new Error(`Unsupported acceptance bridge method: ${method}`);
  }
});
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
  await app.whenReady(); Menu.setApplicationMenu(null);
  const makeWindow = async () => {
    window = new BrowserWindow({ title: "Sidebar Explore Isolated Acceptance", show: false, width: 1440, height: 1000, webPreferences: { preload: join(output, "preload.cjs"), sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    window.setContentSize(1440, 1000);
    window.webContents.on("console-message", (_event, level, message) => { if (level >= 3) errors.push(message); });
    await window.loadFile(join(output, "web/index.html"));
  };
  const socket = new WebSocket(connection.origin.replace("http:", "ws:") + "/v1/events?after=0", ["agent-desktop", connection.token]);
  socket.addEventListener("message", event => { const value = JSON.parse(String(event.data)); if (value.type === "state") void invalidate(); else emit({ ...value, hostId: connection.hostId }); });
  const evaluate = (script: string) => window.webContents.executeJavaScript(script, true);
  const wait = async (expression: string, label = expression) => { const start = Date.now(); while (Date.now() - start < 20_000) { if (await evaluate(expression)) return; await delay(50); } throw new Error(`Timed out: ${label}`); };
  const click = async (selector: string, button: "left" | "right" = "left") => {
    const p = await evaluate(`sidebarExploreTarget(${JSON.stringify(selector)})`);
    window.webContents.sendInputEvent({ type: "mouseMove", ...p });
    window.webContents.sendInputEvent({ type: "mouseDown", ...p, button, clickCount: 1 }); window.webContents.sendInputEvent({ type: "mouseUp", ...p, button, clickCount: 1 });
    inputs.push({ selector, button, p }); await delay(180);
  };
  const key = async (keyCode: string, modifiers: Electron.KeyboardInputEvent["modifiers"] = []) => { window.webContents.sendInputEvent({ type: "keyDown", keyCode, modifiers }); window.webContents.sendInputEvent({ type: "keyUp", keyCode, modifiers }); inputs.push({ keyCode, modifiers }); await delay(120); };
  const capture = async (name: string) => { await delay(200); const snapshot = await evaluate("sidebarExploreState()"), image = await window.webContents.capturePage(); writeFileSync(join(output, `${name}.png`), image.toPNG()); captures.push({ name, snapshot, bounds: window.getContentBounds(), raster: image.getSize(), source: "Electron webContents.capturePage, not native window raster" }); };
  const customize = async () => { await click('.sidebar-explore'); await key("End"); await key("Enter"); await wait('document.activeElement?.getAttribute("aria-label") === "Finish customizing sidebar"', "Customize autofocus"); };
  const saved = async () => { await wait('!document.querySelector(".sidebar-navigation-notice")', "confirmed customization save"); };
  let passed = false, failure: string | undefined;
  try {
    await makeWindow();
    await wait(`document.querySelector('.sidebar-explore') && document.querySelector('.nav-action[aria-label="Pull requests"]')`);
    const navigation = await evaluate('sidebarExploreState().navigation');
    if (navigation.slice(1).join("|") !== "Pull requests|Scheduled|Plugins|Explore") throw new Error(`Unexpected default order: ${navigation}`);
    if (await evaluate('document.querySelector(".sidebar").getBoundingClientRect().width') !== 275) throw new Error("Sidebar width changed");
    await capture("001-default-navigation"); checkpoints.push("default PR-before-Scheduled-before-Plugins, exact275px");
    await click('[aria-label="View activity"]'); await wait('document.querySelector(".sidebar-activity-row")'); await capture("001a-local-activity");
    await click('.sidebar-activity-row'); await wait(`document.querySelector(".header-breadcrumb")?.textContent.includes("Unread sidebar activity fixture")`);
    if (store.bootstrap().state?.route.sessionId !== context.activitySessionId) throw new Error("Activity navigation did not reach its original session");
    await click('[aria-label="Close activity view"]');
    await click('.project-label');
    const projectPoint = await evaluate('sidebarExploreTarget(".sidebar-brand")'); window.webContents.sendInputEvent({ type: "mouseMove", ...projectPoint }); await delay(200);
    if (await evaluate('getComputedStyle(document.querySelector(".project-new")).opacity') !== "0") throw new Error("Project new-chat action remains visible without hover or keyboard focus");
    await capture("001b-project-idle");
    const projectHover = await evaluate('sidebarExploreTarget(".project-row")'); window.webContents.sendInputEvent({ type: "mouseMove", ...projectHover }); await delay(200);
    if (await evaluate('getComputedStyle(document.querySelector(".project-new")).opacity') !== "1") throw new Error("Project hover action unavailable");
    await capture("001c-project-hover");
    await click('.project-new'); await wait('document.querySelector(".header-breadcrumb") && !document.querySelector(".header-breadcrumb").textContent.includes("Unread sidebar activity fixture")');
    checkpoints.push("local unread activity navigates to original session; project folder idle/hover and functioning new-chat control");
    await click('.sidebar-explore'); await key("ArrowDown"); await key("Enter");
    await wait(`document.querySelector('.nav-action[aria-label="Archive"][aria-current="page"]')`, "actual Archive route");
    await capture("002-archive-promoted");
    await click('.sidebar-navigation > .nav-action');
    await wait(`!document.querySelector('.nav-action[aria-label="Archive"][aria-current="page"]')`, "New chat exits Archive");
    await click('.sidebar-explore'); await key("ArrowDown"); await key("Enter");
    await wait(`document.querySelector('.nav-action[aria-label="Archive"][aria-current="page"]')`);
    await click('.sidebar-navigation-pin[aria-label="Pin Archive to sidebar"]');
    await customize(); await saved();
    await click('.sidebar-reorder[aria-label="Reorder Plugins"]'); await key("Space"); await key("ArrowUp"); await key("ArrowUp"); await key("Space"); await saved();
    await capture("003-keyboard-reorder");
    const reordered = await evaluate('sidebarExploreState().rows');
    if (reordered.join("|") !== "plugins|pull-requests|scheduled|archive") throw new Error(`Keyboard order: ${reordered}`);
    await key("Space"); await key("ArrowDown"); await key("Escape");
    if ((await evaluate('sidebarExploreState().rows')).join("|") !== reordered.join("|")) throw new Error("Escape did not cancel reorder");
    await click('.sidebar-visibility[aria-label="Pull requests"]'); await saved(); await capture("004-hidden-pr");
    await click('[aria-label="Finish customizing sidebar"]');
    await wait('document.activeElement?.getAttribute("aria-label") === "Explore"');
    const firstDocument = await evaluate('sidebarExploreState().documentId'); window.destroy(); await makeWindow(); await wait('document.querySelector(".sidebar-explore")');
    if (await evaluate('sidebarExploreState().documentId') === firstDocument) throw new Error("Window did not reopen");
    await customize(); await saved();
    if ((await evaluate('sidebarExploreState().rows')).join("|") !== reordered.join("|")) throw new Error("Order lost on reopen");
    if (await evaluate(`document.querySelector('.sidebar-visibility[aria-label="Pull requests"]').getAttribute("aria-checked")`) !== "false") throw new Error("Visibility lost on reopen");
    await capture("005-reopened-customization"); checkpoints.push("archive route/promote/pin; keyboard reorder/drop/cancel; hide persists on actual window reopen");
    capability = false; await invalidate(); await wait(`!document.querySelector('[data-sidebar-destination="pull-requests"]')`);
    await click('.sidebar-reorder[aria-label="Reorder Archive"]'); await key("Space"); await key("ArrowUp"); await key("Space"); await saved();
    preferenceCapability = false; await invalidate(); await wait('document.querySelector(".sidebar-customization-reset")?.disabled'); await capture("006-capability-loss");
    preferenceCapability = true; capability = true; await invalidate(); await wait(`document.querySelector('[data-sidebar-destination="pull-requests"]') && !document.querySelector(".sidebar-customization-reset").disabled`);
    if (await evaluate(`document.querySelector('.sidebar-visibility[aria-label="Pull requests"]').getAttribute("aria-checked")`) !== "false") throw new Error("Unavailable intent erased");
    await capture("007-capability-recovery"); checkpoints.push("availability projection and preference capability loss/recovery retain unavailable intent and ordering");
    writeFailure = "rejected"; await click('.sidebar-visibility[aria-label="Plugins"]'); await wait('document.body.innerText.includes("Controlled sidebar write rejection")'); await capture("008-rejected-write-retained");
    await click('.sidebar-navigation-notice button'); await saved();
    writeFailure = "lost"; await click('.sidebar-visibility[aria-label="Scheduled"]'); await wait('document.body.innerText.includes("Controlled lost sidebar receipt")'); await capture("009-lost-receipt-retained");
    window.destroy(); await makeWindow(); await wait('document.querySelector(".sidebar-explore")'); await customize(); await click('.sidebar-navigation-notice button'); await saved();
    for (const label of ["Pull requests", "Scheduled", "Plugins", "Archive"]) { if (await evaluate(`document.querySelector('.sidebar-visibility[aria-label="${label}"]').getAttribute('aria-checked') === 'true'`)) { await click(`.sidebar-visibility[aria-label="${label}"]`); await saved(); } }
    await click('[aria-label="Finish customizing sidebar"]'); await capture("010-all-hidden-recovery"); await customize();
    await click('.sidebar-customization-reset'); await saved(); await capture("011-reset");
    await click('[aria-label="Finish customizing sidebar"]');
    await click('.nav-action[aria-label="Pull requests"]'); await wait('document.querySelector(".pull-requests-page")'); await capture("012-actual-pr-route");
    await click('.nav-action[aria-label="Scheduled"]'); await wait('document.querySelector(".automations-page")'); await capture("013-actual-scheduled-route");
    await click('.nav-action[aria-label="Plugins"]'); await wait('document.querySelector(".native-plugin-browser")'); await capture("014-actual-plugin-route");
    await click('.nav-action[aria-label="Plugins"]', "right"); await key("Enter"); await wait('document.querySelector(".sidebar-customization")'); await key("Escape");
    checkpoints.push("rejection/retry; lost receipt/reopen/retry; all-hidden Explore recovery; reset; actual PR/Scheduled/Plugins callbacks; context Customize and Escape");
    writeFileSync(join(output, "confirmed-preferences.json"), JSON.stringify(await http("/v2/preferences"), null, 2));
    passed = true;
  } catch (cause) { failure = String(cause); errors.push(failure); if (window && !window.isDestroyed()) await capture("failure").catch(error => errors.push(String(error))); }
  finally { socket.close(); if (window && !window.isDestroyed()) window.destroy(); writeFileSync(join(output, "result.json"), JSON.stringify({ passed, failure, checkpoints, calls, inputs, captures, errors }, null, 2)); app.exit(passed ? 0 : 1); }
}
void run().catch(cause => { writeFileSync(join(output, "startup-error.txt"), String(cause.stack ?? cause)); app.exit(1); });
