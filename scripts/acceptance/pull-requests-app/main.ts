import { runPullRequestDiscussionFlow } from "./discussion-flow";
import { requestPullRequestWrite } from "../../../apps/desktop/src/main/pull-request-write-transport";
import { runPullRequestWriteFlow } from "./write-flow";
import { app, BrowserWindow, Menu, ipcMain } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPullRequests } from "../../../apps/desktop/src/main/pull-requests-transport";
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
  "pull-requests-app",
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
  let passed = false,
    failure: string | undefined;
  window.webContents.on("console-message", (_event, level, message) => {
    if (level >= 3) errors.push(message);
  });
  const http = (path: string, body?: unknown) =>
    requestHost(connection, path, body);
  ipcMain.on("pull-requests-app-save", (event, value) => {
    event.returnValue = store.saveView(value);
  });
  ipcMain.handle(
    "pull-requests-app-call",
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
        case "pullRequestWrite": {
          if (args[0] !== connection.hostId) throw new Error("Foreign pull request host.");
          if (args[1] === "submit" && !store.bootstrap().state?.pullRequestComposers?.some(entry => JSON.stringify(entry.request) === JSON.stringify(args[2]))) throw new Error("Submission was not saved before dispatch.");
          return requestPullRequestWrite(connection, args[1], args[2]);
        }
        case "pullRequests":
          if (args[0] !== connection.hostId)
            throw new Error("Foreign pull request host.");
          return readPullRequests(connection, args[1]);
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
      window.webContents.send("pull-requests-app-event", event);
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
      `pullRequestsAppTarget(${JSON.stringify(selector)},${JSON.stringify(text)})`,
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
    const state = await evaluate("pullRequestsAppState()"),
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
    await window.loadFile(join(output, "web/index.html"));
    window.webContents.focus();
    await wait(
      `!!document.querySelector('button[aria-label="Pull requests"]')&&!document.body.innerText.includes('Loading conversation')`,
      "App host ready",
    );
    await click("button", "Scheduled");
    await wait(
      `!!document.querySelector('.automations-page')`,
      "other overlay open",
    );
    await click("button", "Pull requests");
    await wait(
      `!!document.querySelector('.pull-requests-page')&&!document.querySelector('.automations-page')`,
      "pull requests closes other overlay",
    );
    checkpoints.push("sidebar-open-closes-other-overlay");
    await wait(
      `document.body.innerText.includes('Native pull request')&&document.body.innerText.includes('octocat · github.com')`,
      "actual host inbox",
    );
    if (
      !calls.some(
        (value: any) =>
          value.method === "pullRequests" && value.args[1] === "accounts",
      ) ||
      !calls.some(
        (value: any) =>
          value.method === "pullRequests" && value.args[1] === "inbox",
      )
    )
      throw new Error("Pull requests did not traverse the main transport.");
    checkpoints.push("authenticated-host-capability-main-transport-private-gh");
    await click("button.pull-request-row");
    await wait(
      `document.querySelector('.pull-request-heading h1')?.textContent==='Native pull request'&&document.body.innerText.includes('Native review comment')&&document.body.innerText.includes('build')`,
      "actual detail",
    );
    checkpoints.push("detail-comments-checks");
    await click("button", "Files changed 1");
    await wait(
      `!!document.querySelector('.review-file')&&document.body.innerText.includes('src/native.ts')&&!document.querySelector('.pull-request-files [role="alert"]')`,
      "actual file diff",
    );
    checkpoints.push("files-through-native-cli");
    await capture("01-files");
    const firstDocument = await evaluate("pullRequestsAppState().documentId");
    await window.webContents.reload();
    await wait(
      `pullRequestsAppState().documentId!==${JSON.stringify(firstDocument)}&&!!document.querySelector('.pull-requests-page')&&document.querySelector('.pull-request-heading h1')?.textContent==='Native pull request'`,
      "reload persisted route and selection",
    );
    checkpoints.push("window-reload-persists-route-and-selection");
    await click("button", "Close pull requests");
    await wait(
      `!document.querySelector('.pull-requests-page')&&document.activeElement?.getAttribute('aria-label')==='Pull requests'`,
      "close and focus restoration",
    );
    checkpoints.push("close-restores-sidebar-focus");
    await click("button", "Pull requests");
    await wait(
      `!!document.querySelector('.pull-requests-page')&&document.querySelector('.pull-request-heading h1')?.textContent==='Native pull request'`,
      "reopen retained selection",
    );
    checkpoints.push("reopen-retains-selection");
    await capture("02-reopened");
    if (process.argv.includes("--discussions")) await runPullRequestDiscussionFlow({ window, fixture, evaluate, wait, click, capture, checkpoints, setConnected: connected => emit({ hostId: connection.hostId, sequence: 0, type: "connection", connected }) });
    if (process.argv.includes("--writes")) await runPullRequestWriteFlow({ window, fixture, evaluate, wait, click, capture, checkpoints });
    if (errors.length)
      throw new Error("Renderer errors: " + JSON.stringify(errors));
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
