import { app, BrowserWindow, Menu, ipcMain } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requestHost } from "../../../apps/desktop/src/main/host-transport";
import { requestVersionedCommand } from "../../../apps/desktop/src/main/command-endpoints";
import { WindowStateStore } from "../../../apps/desktop/src/main/window-state";
import { createDockState } from "../../../apps/desktop/src/renderer/dock-state";
import { defaultWindowView } from "../../../apps/desktop/src/window-state";

const [output, fixture] = process.argv.slice(2) as [string, string];
const connection = JSON.parse(
    readFileSync(join(fixture, "connection.json"), "utf8"),
  ),
  context = JSON.parse(readFileSync(join(fixture, "context.json"), "utf8"));
app.setPath("userData", join(fixture, "electron"));
const store = new WindowStateStore(
  join(fixture, "window"),
  "accounts-model-app",
);
if (!store.bootstrap().state) {
  const result = store.saveView({
    ...defaultWindowView(),
    route: { hostId: connection.hostId, sessionId: context.sessionId },
    workspaceOpen: false,
    dock: {
      tabs: [],
      state: { ...createDockState(), right: { tabIds: [], open: false } },
    },
  });
  if (result.error) throw new Error(result.error);
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function run() {
  await app.whenReady();
  Menu.setApplicationMenu(null);
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      preload: join(output, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  window.setContentSize(1280, 900);
  const calls: unknown[] = [],
    inputs: unknown[] = [],
    captures: unknown[] = [],
    errors: unknown[] = [];
  let accountsMode: "normal" | "old" | "failure" = "normal";
  let passed = false,
    failure: string | undefined;
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  const http = (path: string, body?: unknown) =>
    requestHost(connection, path, body);
  ipcMain.on("accounts-model-app-save", (event, value) => {
    event.returnValue = store.saveView(value);
  });
  ipcMain.handle(
    "accounts-model-app-call",
    async (_event, method: string, args: any[] = []) => {
      calls.push({
        method,
        args: method === "pullRequests" ? [args[0], args[1]?.type] : args,
      });
      switch (method) {
        case "bootstrap":
          return store.bootstrap();
        case "save":
          return store.saveView(args[0]);
        case "getState":
          return http("/v1/state");
        case "getHosts":
          return http("/v1/peers");
        case "getPreferences":
          return http("/v1/preferences");
        case "getTheme":
          return http("/v1/theme");
        case "getComposerCatalog":
          return http("/v1/models/composer", {
            target: args[0],
            refresh: args[1],
          });
        case "getMessages":
          return http(`/v1/sessions/${encodeURIComponent(args[0])}/messages`);
        case "getInteractions":
          return http(
            `/v1/sessions/${encodeURIComponent(args[0])}/interactions`,
          );
        case "getSessionControls":
          return http(`/v1/sessions/${encodeURIComponent(args[0])}/controls`);
        case "workspaceQuery":
          return http("/v1/workspace/query", {
            target: args[0],
            query: args[1],
          });
        case "command":
          return requestVersionedCommand(http, args[0]);
        case "getBtw":
          return http(`/v1/sessions/${encodeURIComponent(args[0])}/btw`);
        case "getComposerActions":
          return http("/v1/composer/actions", {
            target: args[0],
            refresh: args[1],
          });
        case "getComposerCompletions":
          return http("/v1/composer/completions", args[0]);
        case "getProviders": return http("/v1/accounts/providers");
        case "getAccounts": return http(`/v1/accounts/credentials?provider=${encodeURIComponent(args[0])}`);
        case "getLogins": return http("/v1/accounts/logins");
        case "getSessionAccounts": {
          if (accountsMode === "failure") throw new Error("Controlled account read unavailable");
          const selection = await http(`/v1/sessions/${encodeURIComponent(args[0])}/accounts`) as any;
          if (accountsMode === "old") delete selection.selection;
          return selection;
        }
        case "accountAction": {
          if (args[1] !== connection.hostId) throw new Error("Foreign account owner");
          if (!["session.pin", "session.release"].includes(args[0].type)) throw new Error("Fixture permits only disposable session account selection");
          return http("/v1/accounts/actions", args[0]);
        }
        case "openExternal":
          throw new Error("External navigation is disabled in this fixture");
        default:
          throw new Error(`Unsupported fixture bridge method ${method}`);
      }
    },
  );
  const socket = new WebSocket(
    connection.origin.replace("http:", "ws:") + "/v1/events?after=0",
    ["agent-desktop", connection.token],
  );
  const emit = (event: unknown) => {
    if (!window.isDestroyed())
      window.webContents.send("accounts-model-app-event", event);
  };
  socket.addEventListener("message", (event) =>
    emit({ ...JSON.parse(String(event.data)), hostId: connection.hostId }),
  );
  socket.addEventListener("open", () =>
    emit({
      hostId: connection.hostId,
      sequence: 0,
      type: "connection",
      connected: true,
    }),
  );
  const evaluate = (script: string) =>
    window.webContents.executeJavaScript(script, true);
  const wait = async (expression: string, label: string) => {
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    throw new Error(`Timed out: ${label}`);
  };
  const click = async (selector: string, text?: string) => {
    const p = await evaluate(
      `accountsModelAppTarget(${JSON.stringify(selector)},${JSON.stringify(text)})`,
    );
    window.webContents.sendInputEvent({ type: "mouseMove", ...p });
    window.webContents.sendInputEvent({
      type: "mouseDown",
      ...p,
      button: "left",
      clickCount: 1,
    });
    window.webContents.sendInputEvent({
      type: "mouseUp",
      ...p,
      button: "left",
      clickCount: 1,
    });
    inputs.push({ selector, text, p });
    await delay(150);
  };
  const capture = async (name: string) => {
    await delay(250);
    const state = await evaluate("accountsModelAppState()"),
      image = await window.webContents.capturePage();
    writeFileSync(join(output, `${name}.png`), image.toPNG());
    captures.push({
      name,
      state,
      bounds: window.getContentBounds(),
      raster: image.getSize(),
    });
  };
  const checkpoints: string[] = [];
  try {
    await window.loadFile(join(output, "web/index.html")); window.show(); window.webContents.focus();
    await wait(`!!document.querySelector('button[aria-label="Model and reasoning effort"]')&&!document.body.innerText.includes('Loading conversation')`, "App native session ready");
    await click("button", "Model and reasoning effort"); await click("button", "Session account");
    await wait(`document.querySelectorAll('.session-account-choice').length===2`, "native OAuth choices");
    await capture("01-native-session-accounts"); checkpoints.push("actual-App-native-owner-oauth-catalog");
    await click(".session-account-choice", "account@example.invalid (Second organization)Use for this session");
    await wait(`!![...document.querySelectorAll('.session-account-choice')].find(n=>n.textContent.includes('Second organization')&&n.getAttribute('aria-pressed')==='true')`, "selected second account");
    await capture("02-native-account-selected"); checkpoints.push("native-account-pin-confirmed");
    const beforeReload = await http(`/v1/sessions/${context.sessionId}/accounts`);
    if (!(beforeReload as any).accounts.some((account:any)=>account.orgName==='Second organization'&&account.active)) throw new Error("Native host selection did not change");
    await window.reload();
    await wait(`!!document.querySelector('button[aria-label="Model and reasoning effort"]')&&!document.body.innerText.includes('Loading conversation')`, "App reloaded");
    await click("button", "Model and reasoning effort"); await click("button", "Session account");
    await wait(`!![...document.querySelectorAll('.session-account-choice')].find(n=>n.textContent.includes('Second organization')&&n.getAttribute('aria-pressed')==='true')`, "native selected account after document reload");
    checkpoints.push("document-reload-native-account-retained");
    await click("button", "Release for next native selection");
    await wait(`document.querySelectorAll('.session-account-choice[aria-pressed="true"]').length===0&&!document.body.innerText.includes('Applying account selection')`, "native release receipt");
    await capture("03-native-release"); checkpoints.push("native-release-next-selection");
    window.webContents.sendInputEvent({type:"keyDown",keyCode:"Escape"});window.webContents.sendInputEvent({type:"keyUp",keyCode:"Escape"});
    await wait(`!document.querySelector('[aria-label="Select session account"]')&&document.activeElement?.getAttribute('aria-label')==='Model and reasoning effort'`, "Escape restores original model trigger focus");
    checkpoints.push("keyboard-close-focus");
    await click("button", "Model and reasoning effort"); await click("button", "Session account");
    await wait(`document.querySelectorAll('.session-account-choice').length===2`, "reopened choices");
    accountsMode = "failure"; await click("button", "Refresh accounts");
    await wait(`document.body.innerText.includes('Controlled account read unavailable')`, "account refresh error");
    if (!await evaluate(`[...document.querySelectorAll('.session-account-choice')].every(n=>n.disabled)`)) throw new Error("Failed account read enabled stale mutation");
    await capture("04-error-retained"); checkpoints.push("failed-refresh-retains-readable-no-write");
    accountsMode = "old"; await click("button", "Refresh accounts");
    await wait(`document.body.innerText.includes('Update the owning host')`, "older host unavailable");
    if (!await evaluate(`[...document.querySelectorAll('.session-account-choice')].every(n=>n.disabled)`)) throw new Error("Older host enabled unguarded account action");
    await capture("05-older-host"); checkpoints.push("older-host-token-absence-disables-switch");
    accountsMode = "normal"; await click("button", "Refresh accounts");
    await wait(`!!document.querySelector('.session-account-choice:not(:disabled)')`, "fresh guarded retry");
    await click(".session-account-choice", "account@example.invalid (First organization)Use for this session");
    await wait(`!!document.querySelector('.session-account-choice[aria-pressed="true"]')`, "fresh pin after retry");
    const beforeOffline = calls.filter((call:any)=>call.method==='accountAction').length;
    emit({ hostId: connection.hostId, type: "connection", sequence: 0, connected: false });
    await wait(`document.body.innerText.includes('Disconnected. Last reported accounts')`, "offline account view");
    if (!await evaluate(`[...document.querySelectorAll('.session-account-choice')].every(n=>n.disabled)`)) throw new Error("Offline account action enabled");
    await capture("06-offline");
    if (calls.filter((call:any)=>call.method==='accountAction').length !== beforeOffline) throw new Error("Offline transition dispatched account mutation");
    emit({ hostId: connection.hostId, type: "connection", sequence: 0, connected: true });
    await wait(`!!document.querySelector('.session-account-choice:not(:disabled)')`, "native account reconnect"); checkpoints.push("offline-preserves-and-reconnect-revalidates");
    window.webContents.sendInputEvent({type:"keyDown",keyCode:"Escape"});window.webContents.sendInputEvent({type:"keyUp",keyCode:"Escape"});
    await click("#active-host"); await click(".profile-menu button", "Settings⌘,");
    await click("button", "Accounts");
    await wait(`!!document.querySelector('[aria-label="Accounts settings"]')&&document.querySelectorAll('.session-account-choice').length===2`, "actual Accounts settings native choices");
    if (!await evaluate(`!![...document.querySelectorAll('.session-account-choice')].find(n=>n.textContent.includes('First organization')&&n.getAttribute('aria-pressed')==='true')`)) throw new Error("Accounts settings did not reflect composer pin");
    await capture("07-settings-mirror"); checkpoints.push("Accounts-and-composer-share-native-session-choice");
    await click(".session-account-choice", "account@example.invalid (Second organization)Use for this session");
    await wait(`!![...document.querySelectorAll('.session-account-choice')].find(n=>n.textContent.includes('Second organization')&&n.getAttribute('aria-pressed')==='true')`, "Settings native pin");
    await click("button", "Close settings"); await click("button", "Model and reasoning effort"); await click("button", "Session account");
    await wait(`!![...document.querySelectorAll('.session-account-choice')].find(n=>n.textContent.includes('Second organization')&&n.getAttribute('aria-pressed')==='true')`, "Settings choice in composer");
    await capture("08-settings-to-composer"); checkpoints.push("Settings-pin-reflects-on-composer-reopen");
    passed = true;
  } catch (error) {
    failure = error instanceof Error ? error.stack : String(error);
    await capture("failure").catch(() => {});
  } finally {
    socket.close();
    window.destroy();
    writeFileSync(
      join(output, "result.json"),
      JSON.stringify(
        { passed, failure, checkpoints, calls, inputs, captures, errors },
        null,
        2,
      ),
    );
    app.exit(passed ? 0 : 1);
  }
}
void run().catch((error) => {
  writeFileSync(
    join(output, "startup-error.txt"),
    String(error.stack ?? error),
  );
  app.exit(1);
});
