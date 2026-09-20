import { app, BrowserWindow, Menu, ipcMain } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requestHost } from "../../../apps/desktop/src/main/host-transport";
import { requestVersionedCommand } from "../../../apps/desktop/src/main/command-endpoints";
import { requestSessionUsage, requestSessionUsageCommand } from "../../../apps/desktop/src/main/session-usage-transport";
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
  "session-usage-app",
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
  let passed = false,
    failure: string | undefined;
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  const http = (path: string, body?: unknown) =>
    requestHost(connection, path, body);
  ipcMain.on("session-usage-app-save", (event, value) => {
    event.returnValue = store.saveView(value);
  });
  ipcMain.handle(
    "session-usage-app-call",
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
            if (args[1] !== connection.hostId) throw new Error("Foreign provider-usage owner");
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
          if (args[1] !== connection.hostId) throw new Error("Foreign provider-usage owner");
          return requestSessionUsage(connection, args[0], args[2], args[3]);
        case "getBtw":
          return http(`/v1/sessions/${encodeURIComponent(args[0])}/btw`);
        case "getComposerActions":
          return http("/v1/composer/actions", {
            target: args[0],
            refresh: args[1],
          });
        case "getComposerCompletions":
          return http("/v1/composer/completions", args[0]);
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
      window.webContents.send("session-usage-app-event", event);
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
      `sessionUsageAppTarget(${JSON.stringify(selector)},${JSON.stringify(text)})`,
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
    const state = await evaluate("sessionUsageAppState()"),
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
  let hostRestart: unknown, workerReplacement: unknown;
  let reportedNativePolicy: boolean | undefined;
  try {
    await window.loadFile(join(output, "web/index.html")); window.show(); window.webContents.focus();
    await wait(`!!document.querySelector('button[aria-label="Conversation actions"]')&&!document.body.innerText.includes('Loading conversation')&&!document.body.innerText.includes('Loading this workspace’s native models')`, "App native session ready");
    const state = await http("/v1/state") as any;
    reportedNativePolicy = state.sessionUsage?.nativePolicy;
    if (reportedNativePolicy !== false) throw new Error("The bf17 fixture must record the current false nativePolicy capability without relabeling it.");

    await click("button", "Conversation actions");
    await click("button", "Provider usage…");
    await wait(`!!document.querySelector('.session-usage-dialog')&&document.body.innerText.includes('Original conversation')`, "Provider usage dialog");
    if (consumeCount() !== 0) throw new Error("Opening provider usage consumed a credit");
    await click("button", "Inspect saved credits");
    await wait(`[...document.querySelectorAll('.session-usage-dialog button')].filter(n=>n.textContent?.includes('Spend one saved reset')).length===2`, "two native account credit rows");
    if (!await evaluate(`document.body.innerText.includes('first · Organization org-first')&&document.body.innerText.includes('second · Organization org-second')`)) throw new Error("Same-email native accounts were not separately identified");
    if (consumeCount() !== 0) throw new Error("Credit inspection consumed a credit");
    await capture("01-saved-credits"); checkpoints.push("native-candidate-credit-actions-zero-consume");

    writeFileSync(join(fixture, "wire-mode"), "hold-exit");
    const heldBefore = rows("held-read.jsonl").length;
    await click("button", "Refresh provider reports");
    await waitFile("held-read.jsonl", value => value.trim().split("\n").filter(Boolean).length > heldBefore);
    const heldPid = rows("held-read.jsonl").at(-1)?.pid;
    const startsBeforeExit = rows("worker-starts.jsonl").length;
    writeFileSync(join(fixture, "wire-mode"), "exit-held");
    await wait(`document.body.innerText.includes('Provider usage could not be confirmed')&&document.body.innerText.includes('first · Organization org-first')`, "held report failure retains cached credit state");
    writeFileSync(join(fixture, "wire-mode"), "normal");
    await delay(250);
    if (rows("worker-starts.jsonl").length <= startsBeforeExit) await click("button", "Refresh provider reports");
    await waitFile("worker-starts.jsonl", value => value.trim().split("\n").filter(Boolean).length > startsBeforeExit);
    let replacementRefresh = false;
    for (let attempt = 0; attempt < 3 && !replacementRefresh; attempt++) {
      await click("button", "Refresh provider reports");
      await wait(`![...document.querySelectorAll('.session-usage-dialog button')].some(n=>n.textContent==='Refresh provider reports'&&n.disabled)`, "replacement report refresh completion");
      replacementRefresh = await evaluate(`!document.body.innerText.includes('Provider usage could not be confirmed')&&document.body.innerText.includes('12.0% used')`);
    }
    if (!replacementRefresh) throw new Error("Replacement worker did not produce a fresh report after explicit retries");
    const replacementPid = rows("usage-pids.jsonl").at(-1)?.pid;
    if (!Number.isInteger(heldPid) || !Number.isInteger(replacementPid) || heldPid === replacementPid) throw new Error("Held read did not bind distinct original and replacement worker processes");
    workerReplacement = { heldPid, replacementPid, distinct: true };
    await capture("02-held-read-replacement"); checkpoints.push("held-read-original-worker-exit-cached-retention-replacement-refresh", "actual-App-authenticated-host-replacement-worker-reports");
    await click("button", "Inspect saved credits");
    await wait(`[...document.querySelectorAll('.session-usage-dialog button')].filter(n=>n.textContent?.includes('Spend one saved reset')).length===2`, "replacement worker native credit rows");
    if (consumeCount() !== 0) throw new Error("Replacement credit inspection consumed a credit");
    await capture("03-replacement-credits"); checkpoints.push("replacement-worker-credit-candidates-zero-consume");

    await click(".session-usage-dialog article button", "Spend one saved reset…");
    await wait(`document.body.innerText.includes('Review this exact account and saved credit')`, "prepared reset receipt");
    await capture("04-prepared-cancel");
    await click("button", "Cancel");
    await wait(`document.body.innerText.includes('Confirmation cancelled. No reset was requested.')`, "cancelled reset receipt");
    if (consumeCount() !== 0) throw new Error("Cancel consumed a credit");
    checkpoints.push("prepare-cancel-zero-consume");

    await click(".session-usage-dialog article button", "Spend one saved reset…");
    await wait(`document.body.innerText.includes('Review this exact account and saved credit')`, "second prepared reset receipt");
    duplicateNextConfirmation = true;
    await click("button", "Confirm: spend one saved reset");
    await wait(`document.body.innerText.includes('One saved reset was applied.')`, "settled reset receipt");
    if (consumeCount() !== 1) throw new Error(`Expected one consume after duplicate delivery, observed ${consumeCount()}`);
    await capture("05-confirmed-deduplicated"); checkpoints.push("explicit-confirm-single-consume-duplicate-delivery-deduplicated");

    await click("button", "Inspect saved credits");
    await wait(`![...document.querySelectorAll('.session-usage-dialog button')].some(n=>n.textContent==='Inspect saved credits'&&n.disabled)`, "credits refresh complete after settlement");
    await click(".session-usage-dialog article button", "Spend one saved reset…");
    await wait(`document.body.innerText.includes('Review this exact account and saved credit')`, "unknown-path prepared reset receipt");
    writeFileSync(join(fixture, "wire-mode"), "unknown");
    await click("button", "Confirm: spend one saved reset");
    await wait(`document.body.innerText.includes('Outcome unconfirmed. Inspect this original reset; another credit will not be selected.')`, "unknown reset receipt");
    if (consumeCount() !== 2) throw new Error(`Expected one lost-reply consume, observed ${consumeCount()}`);
    if (!await evaluate(`[...document.querySelectorAll('.session-usage-dialog button')].filter(n=>n.textContent?.includes('Spend one saved reset')).every(n=>n.disabled)`)) throw new Error("Unknown receipt did not disable replacement preparation");
    await capture("06-unknown-no-replacement");
    await click("button", "Close");
    hostRestart = await restartHost();
    await click("button", "Conversation actions");
    await click("button", "Provider usage…");
    await wait(`document.body.innerText.includes('Outcome unconfirmed. Inspect this original reset; another credit will not be selected.')`, "cached unknown receipt after reopen");
    if (consumeCount() !== 2) throw new Error("Reopening the dialog retried an unknown outcome");
    await click("button", "Inspect original receipt");
    await wait(`![...document.querySelectorAll('.session-usage-dialog button')].some(n=>n.textContent==='Inspect original receipt'&&n.disabled)`, "original unknown receipt inspection");
    if (consumeCount() !== 2) throw new Error("Inspecting the original unknown receipt retried a consume");
    await capture("07-unknown-after-host-restart"); checkpoints.push("unknown-receipt-host-restart-reopen-inspection-no-retry");
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
        { passed, failure, checkpoints, reportedNativePolicy, consumeCalls: consumeCount(), workerReplacement, hostRestart, calls, inputs, captures, errors },
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
