import { app, BrowserWindow, Menu, ipcMain } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requestHost } from "../../../apps/desktop/src/main/host-transport";
import { requestVersionedCommand } from "../../../apps/desktop/src/main/command-endpoints";
import { requestSessionUsage, requestSessionUsageCommand } from "../../../apps/desktop/src/main/session-usage-transport";
import { requestComposerActions, requestComposerCompletions } from "../../../apps/desktop/src/main/composer-actions-transport";
import { WindowStateStore } from "../../../apps/desktop/src/main/window-state";
import { createDockState } from "../../../apps/desktop/src/renderer/dock-state";
import { defaultWindowView } from "../../../apps/desktop/src/window-state";

const [output, fixture] = process.argv.slice(2) as [string, string];
let connection = JSON.parse(
    readFileSync(join(fixture, "connection.json"), "utf8"),
  ),
  context = JSON.parse(readFileSync(join(fixture, "context.json"), "utf8"));
app.setPath("userData", join(fixture, "electron"));
const store = new WindowStateStore(
  join(fixture, "window"),
  "usage-command-app",
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
    minWidth: 720,
    minHeight: 480,
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
  let duplicateNextConfirmation = false;
  let projectOldHost = false;
  let passed = false,
    failure: string | undefined;
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  const http = (path: string, body?: unknown) =>
    requestHost(connection, path, body);
  ipcMain.on("usage-command-app-save", (event, value) => {
    event.returnValue = store.saveView(value);
  });
  ipcMain.handle(
    "usage-command-app-call",
    async (_event, method: string, args: any[] = []) => {
      calls.push({ method, args });
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
          if (args[0]?.command?.type === "session.usage.reset.prepare" || args[0]?.command?.type === "session.usage.reset.respond") {
            if (args[1] !== connection.hostId) throw new Error("Foreign usage-command owner");
            if (duplicateNextConfirmation && args[0].command.type === "session.usage.reset.respond" && args[0].command.confirm === true) {
              duplicateNextConfirmation = false;
              const [first, duplicate] = await Promise.all([
                requestSessionUsageCommand(connection, args[0]),
                requestSessionUsageCommand(connection, args[0]),
              ]);
              calls.push({ method: "controlledDuplicateDelivery", commandId: args[0].id });
              if (JSON.stringify(first) !== JSON.stringify(duplicate)) throw new Error("Duplicate command receipts diverged");
              return first;
            }
            return requestSessionUsageCommand(connection, args[0]);
          }
          return requestVersionedCommand(http, args[0]);
        case "getSessionUsage":
          if (args[1] !== connection.hostId) throw new Error("Foreign usage-command owner");
          {
            const value = await requestSessionUsage(connection, args[0], args[2], args[3]);
            if (projectOldHost && value?.snapshot) delete value.snapshot.resetCommandAccounts;
            return value;
          }
        case "fixtureOldHost":
          projectOldHost = Boolean(args[0]); return projectOldHost;
        case "getBtw":
          return http(`/v1/sessions/${encodeURIComponent(args[0])}/btw`);
        case "getComposerActions":
          return requestComposerActions(connection, args[0], args[1]);
        case "getComposerCompletions":
          return requestComposerCompletions(connection, args[0]);
        case "openExternal":
          throw new Error("External navigation is disabled in this fixture");
        default:
          throw new Error(`Unsupported fixture bridge method ${method}`);
      }
    },
  );
  let socket: WebSocket | undefined;
  const emit = (event: unknown) => {
    if (!window.isDestroyed())
      window.webContents.send("usage-command-app-event", event);
  };
  const connectEvents = () => new Promise<void>((resolve, reject) => {
    socket = new WebSocket(connection.origin.replace("http:", "ws:") + "/v1/events?after=0", ["agent-desktop", connection.token]);
    socket.addEventListener("message", (event) => emit({ ...JSON.parse(String(event.data)), hostId: connection.hostId }));
    socket.addEventListener("open", () => { emit({
      hostId: connection.hostId,
      sequence: 0,
      type: "connection",
      connected: true,
    }); resolve(); });
    socket.addEventListener("close", () => emit({ hostId: connection.hostId, sequence: 0, type: "connection", connected: false }));
    socket.addEventListener("error", () => reject(new Error("Host event connection failed")), { once: true });
  });
  void connectEvents();
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
    await wait(`(() => {
      const selector = ${JSON.stringify(selector)}, text = ${JSON.stringify(text)};
      return [...document.querySelectorAll(selector)].some(node => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !node.closest('[hidden], [inert]') && !node.disabled &&
          (text === undefined || node.textContent?.trim() === text || node.getAttribute('aria-label') === text);
      });
    })()`, `enabled visible target ${selector} ${text ?? ''}`);
    const p = await evaluate(
      `usageCommandAppTarget(${JSON.stringify(selector)},${JSON.stringify(text)})`,
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
  const key = async (keyCode: string) => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode });
    inputs.push({ keyCode }); await delay(100);
  };
  const type = async (text: string) => {
    await click("#prompt");
    if (await evaluate("usageCommandAppState().prompt.text")) { window.webContents.selectAll(); await delay(75); }
    await window.webContents.insertText(text);
    await wait(`usageCommandAppState().prompt.text===${JSON.stringify(text)}`, `composer text ${text}`);
    await delay(100);
  };
  const capture = async (name: string) => {
    await delay(250);
    const state = await evaluate("usageCommandAppState()"),
      image = await window.webContents.capturePage();
    writeFileSync(join(output, `${name}.png`), image.toPNG());
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
    const accessibility = await window.webContents.debugger.sendCommand("Accessibility.getFullAXTree");
    writeFileSync(join(output, `${name}.ax.json`), JSON.stringify(accessibility, null, 2));
    captures.push({
      name,
      state,
      bounds: window.getContentBounds(),
      raster: image.getSize(),
    });
  };
  const checkpoints: string[] = [];
  const consumeCount = () => {
    try { return readFileSync(join(fixture, "consume.jsonl"), "utf8").trim().split("\n").filter(Boolean).length; }
    catch { return 0; }
  };
  const rows = (name: string) => {
    try { return readFileSync(join(fixture, name), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  };
  const waitFile = async (name: string, predicate: (value: string) => boolean) => {
    const start = Date.now();
    while (Date.now() - start < 20_000) {
      let value = ""; try { value = readFileSync(join(fixture, name), "utf8"); } catch {}
      if (predicate(value)) return value;
      await delay(20);
    }
    throw new Error(`Timed out waiting for fixture file ${name}`);
  };
  const restartHost = async () => {
    const previous = connection, request = crypto.randomUUID();
    writeFileSync(join(fixture, "restart-host"), request);
    await waitFile("restart-complete", value => value === request);
    connection = JSON.parse(readFileSync(join(fixture, "connection.json"), "utf8"));
    if (connection.hostId !== previous.hostId || connection.origin !== previous.origin || connection.token === previous.token)
      throw new Error("Disposable host restart changed owner/origin or retained its authentication token");
    socket?.close(); await connectEvents();
    return { sameHostId: true, sameOrigin: true, tokenChanged: true };
  };
  try {
    await window.loadFile(join(output, "web/index.html")); window.show(); window.webContents.focus();
    await wait(`usageCommandAppState().prompt.disabled === "false" && !usageCommandAppState().body.includes("Loading conversation")`, "App native session ready");

    await type("/usage"); await key("ESCAPE"); await key("ENTER");
    await wait(`usageCommandAppState().prompt.text === "" && document.body.innerText.includes("12.00%")`, "bare native usage report");
    if (consumeCount() !== 0) throw new Error("Bare /usage consumed a saved reset");
    checkpoints.push("bare-native-usage-handler-report-zero-consume");

    await type("/usage show"); await key("ESCAPE"); await key("ENTER");
    await wait(`usageCommandAppState().prompt.text === ""`, "show native usage dispatch");
    if (consumeCount() !== 0) throw new Error("/usage show consumed a saved reset");
    checkpoints.push("show-native-usage-handler-zero-consume");

    await type("/usage malformed"); await key("ESCAPE"); await key("ENTER");
    await wait(`usageCommandAppState().prompt.text === "" && document.body.innerText.includes("Usage")`, "malformed native usage output");
    checkpoints.push("malformed-native-handler-output");

    await type("/usage reset"); await key("ESCAPE"); await key("ENTER");
    await wait(`!!document.querySelector(".session-usage-dialog") && [...document.querySelectorAll(".session-usage-dialog button")].filter(node=>node.textContent?.includes("Spend one saved reset")).length===2`, "no-argument reset chooser");
    if (consumeCount() !== 0) throw new Error("Opening /usage reset chooser consumed a credit");
    const chooser = await evaluate(`usageCommandAppCall("getSessionUsage", [${JSON.stringify(context.sessionId)}, ${JSON.stringify(connection.hostId)}, "credits"])`);
    const accounts = chooser.snapshot?.resetCommandAccounts;
    if (!Array.isArray(accounts) || accounts.length !== 2 || !accounts[0].active) throw new Error("Native reset chooser did not preserve native active-first ordering");
    if (!await evaluate(`document.body.innerText.indexOf("first · Organization org-first") < document.body.innerText.indexOf("second · Organization org-second")`))
      throw new Error("Visible reset chooser did not follow native account order");
    await capture("01-reset-native-order");
    await click("button", "Close");
    checkpoints.push("reset-noargs-native-order-zero-consume");

    const exact = accounts[0].label;
    await type(`/usage reset ${exact}`); await key("ESCAPE"); await key("ENTER");
    await wait(`document.body.innerText.includes("Review this exact account and saved credit")`, "explicit exact account preparation");
    if (consumeCount() !== 0) throw new Error("Preparation consumed before confirmation");
    await click("button", "Cancel");
    await wait(`document.body.innerText.includes("Confirmation cancelled. No reset was requested.")`, "explicit cancellation");
    if (consumeCount() !== 0) throw new Error("Cancellation consumed a credit");
    checkpoints.push("explicit-full-label-prepare-cancel-zero-consume");

    await click("button", "Close");
    await type(`/usage reset ${exact}`); await key("ESCAPE"); await key("ENTER");
    await wait(`document.body.innerText.includes("Review this exact account and saved credit")`, "second explicit account preparation");
    await click("button", "Confirm: spend one saved reset");
    await wait(`document.body.innerText.includes("One saved reset was applied.")`, "independent explicit confirmation");
    if (consumeCount() !== 1) throw new Error(`Expected one controlled consume, observed ${consumeCount()}`);
    await capture("02-explicit-confirm"); checkpoints.push("independent-confirm-single-controlled-consume");
    await click("button", "Close");

    await type("/usage reset absent@fixture.invalid"); await key("ESCAPE"); await key("ENTER");
    await wait(`usageCommandAppState().prompt.text === "" && usageCommandAppState().body.includes("No Codex account matches")`, "missing account native notice");
    checkpoints.push("missing-match-native-notice-clears-unchanged-draft-no-prepare");
    await click("button", "Close");

    await evaluate(`usageCommandAppCall("fixtureOldHost", [true])`);
    await type(`/usage reset ${exact}`); await key("ESCAPE"); await key("ENTER");
    await wait(`usageCommandAppState().prompt.text === ${JSON.stringify(`/usage reset ${exact}`)} && usageCommandAppState().body.includes("Update the owning host")`, "old host retains draft");
    await evaluate(`usageCommandAppCall("fixtureOldHost", [false])`);
    if (consumeCount() !== 1) throw new Error("Rejected reset routing consumed another credit");
    await capture("03-rejections-retain-draft"); checkpoints.push("missing-and-old-host-rejections-retain-draft");
    await click("button", "Close");

    writeFileSync(join(fixture, "wire-mode"), "hold-list");
    const heldBefore = rows("held-credit-read.jsonl").length;
    const preparesBefore = calls.filter((call: any) => call.method === "command" && call.args[0]?.command?.type === "session.usage.reset.prepare").length;
    await type("/usage reset active"); await key("ESCAPE"); await key("ENTER");
    await waitFile("held-credit-read.jsonl", value => value.trim().split("\n").filter(Boolean).length > heldBefore);
    await wait(`!!document.querySelector(".session-usage-dialog")`, "held reset dialog");
    await click("button", "Close");
    await evaluate(`document.querySelector("#prompt")?.focus()`); window.webContents.selectAll();
    await window.webContents.insertText("newer composer text");
    writeFileSync(join(fixture, "wire-mode"), "normal");
    await wait(`usageCommandAppState().prompt.text === "newer composer text"`, "newer composer text survives held read");
    await delay(300);
    const preparesAfter = calls.filter((call: any) => call.method === "command" && call.args[0]?.command?.type === "session.usage.reset.prepare").length;
    if (preparesAfter !== preparesBefore || consumeCount() !== 1) throw new Error("Closed held read prepared or consumed a saved reset");
    await capture("04-held-close-newer-draft"); checkpoints.push("held-original-read-close-and-newer-composer-draft-no-prepare");

    writeFileSync(join(fixture, "wire-mode"), "hold-list");
    const flapHeldBefore = rows("held-credit-read.jsonl").length;
    const flapPreparesBefore = calls.filter((call: any) => call.method === "command" && call.args[0]?.command?.type === "session.usage.reset.prepare").length;
    await type("/usage reset active"); await key("ESCAPE"); await key("ENTER");
    await waitFile("held-credit-read.jsonl", value => value.trim().split("\n").filter(Boolean).length > flapHeldBefore);
    await wait(`!!document.querySelector(".session-usage-dialog")`, "connection-flap held reset dialog");
    const disconnected = new Promise<void>(resolve => socket!.addEventListener("close", () => resolve(), { once: true }));
    socket!.close(); await disconnected; await delay(100); await connectEvents(); await delay(100);
    writeFileSync(join(fixture, "wire-mode"), "normal");
    await wait(`usageCommandAppState().prompt.text === "/usage reset active" && usageCommandAppState().body.includes("original conversation or connection changed")`, "connection flap rejects old reply and retains draft");
    const flapPreparesAfter = calls.filter((call: any) => call.method === "command" && call.args[0]?.command?.type === "session.usage.reset.prepare").length;
    if (flapPreparesAfter !== flapPreparesBefore || consumeCount() !== 1) throw new Error("Connection-flapped old read prepared or consumed a saved reset");
    await click("button", "Close");
    await type("/usage reset active"); await key("ESCAPE"); await key("ENTER");
    await wait(`document.body.innerText.includes("Review this exact account and saved credit")`, "fresh reset retry after connection flap");
    await click("button", "Cancel");
    await wait(`document.body.innerText.includes("Confirmation cancelled. No reset was requested.")`, "fresh retry cancellation");
    if (consumeCount() !== 1) throw new Error("Fresh retry cancellation consumed another credit");
    await capture("05-connection-flap-fresh-retry"); checkpoints.push("held-read-disconnect-reconnect-rejects-old-reply-fresh-retry-prepares");
    passed = true;
  } catch (error) {
    failure = error instanceof Error ? error.stack : String(error);
    await capture("failure").catch(() => {});
  } finally {
    socket?.close();
    window.destroy();
    writeFileSync(
      join(output, "result.json"),
      JSON.stringify(
        { passed, failure, checkpoints, consumeCalls: consumeCount(), calls, inputs, captures, errors,
          scope: "Actual production App, authenticated disposable host/native OMP command handling and controlled local provider transport. Synthetic Electron input is author acceptance, not physical input proof." },
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
