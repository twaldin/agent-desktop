import { app, BrowserWindow, ipcMain } from "electron";
import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readPullRequests } from "../../../apps/desktop/src/main/pull-requests-transport";
const output = process.argv[2]!;
const endpoint = JSON.parse(
  readFileSync(join(output, "endpoint.json"), "utf8"),
);
app.setPath("userData", join(output, "electron-profile"));
const calls: unknown[] = [],
  errors: string[] = [],
  checkpoints: string[] = [];
let win!: BrowserWindow;
ipcMain.handle(
  "pr-call",
  async (_event, channel: string, host: string, input: any) => {
    if (channel === "external") {
      calls.push({ external: host });
      return;
    }
    if (channel !== "host:pull-requests" || host !== endpoint.hostId)
      throw new Error("Foreign fixture route");
    calls.push(input);
    return readPullRequests(endpoint, input);
  },
);
const js = <T>(code: string): Promise<T> =>
  win.webContents.executeJavaScript(code);
const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
async function wait(code: string) {
  const until = Date.now() + 15_000;
  while (!(await js<boolean>(code))) {
    if (Date.now() > until) throw new Error(`Timed out: ${code}`);
    await pause();
  }
}
async function click(selector: string, text?: string) {
  const point = await js<{ x: number; y: number }>(
    `window.pullRequestsTarget(${JSON.stringify(selector)},${JSON.stringify(text)})`,
  );
  win.webContents.sendInputEvent({
    type: "mouseDown",
    button: "left",
    clickCount: 1,
    ...point,
  });
  win.webContents.sendInputEvent({
    type: "mouseUp",
    button: "left",
    clickCount: 1,
    ...point,
  });
}
async function capture(name: string) {
  checkpoints.push(name);
  await writeFile(
    join(
      output,
      `${checkpoints.length.toString().padStart(2, "0")}-${name}.png`,
    ),
    (await win.webContents.capturePage()).toPNG(),
  );
}
async function control(value: unknown) {
  await fetch(`${endpoint.origin}/control`, {
    method: "POST",
    body: JSON.stringify(value),
  });
}
async function run() {
  await app.whenReady();
  try {
    win = new BrowserWindow({
      width: 1200,
      height: 820,
      show: true,
      webPreferences: {
        preload: join(output, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.webContents.on("console-message", (_event, level, message) => {
      if (level >= 3) errors.push(message);
    });
    win.webContents.on("render-process-gone", (_event, details) =>
      errors.push(`Renderer gone: ${details.reason}`),
    );
    await win.loadFile(join(output, "web/index.html"));
    await wait(`document.querySelectorAll('.pull-request-row').length === 3`);
    await capture("inbox");
    await click(".pull-request-row");
    await wait(`!!document.querySelector('.pull-request-description')`);
    await capture("overview");
    const selectedCalls = calls.length;
    await click('.pull-request-row[aria-pressed="true"]');
    await pause();
    if (
      !(await js(`!!document.querySelector('.pull-request-description')`)) ||
      calls.length !== selectedCalls
    )
      throw new Error(
        "Selected row click discarded its detail or dispatched again",
      );
    await click("button", "Files changed 1");
    await wait(`!!document.querySelector('.review-file')`);
    await capture("files");
    await click("button", "Close pull requests");
    await click("button", "Reopen pull requests");
    await wait(`!!document.querySelector('.pull-request-description')`);
    await capture("reopen");
    await js(`window.pullRequestsControl({connected:false})`);
    await wait(`document.body.innerText.includes('offline')`);
    const offlineCalls = calls.length;
    await click("button", "Files changed 1");
    await pause();
    if (calls.length !== offlineCalls)
      throw new Error("Offline page dispatched a read");
    await capture("offline-cache");
    await js(`window.pullRequestsControl({connected:true})`);
    await wait(`!document.body.innerText.includes('offline')`);
    await pause();
    await control({ holdDetail: true });
    await click('.pull-request-row[aria-pressed="false"]');
    await wait(`document.body.innerText.includes('Loading pull request')`);
    await click("button", "Close pull requests");
    await control({ releaseDetail: true });
    await pause();
    await click("button", "Reopen pull requests");
    await wait(`!!document.querySelector('.pull-request-description')`);
    await capture("retired-read");
    await control({ failInbox: true });
    await click("button", "Refresh pull requests");
    await wait(`document.body.innerText.includes('Controlled GitHub outage')`);
    if (
      (await js<number>(
        `document.querySelectorAll('.pull-request-row').length`,
      )) !== 3
    )
      throw new Error("Refresh failure erased prior results");
    await capture("refresh-error");
    await control({ failInbox: false });
    await click("button", "Try again");
    await wait(`!document.body.innerText.includes('Controlled GitHub outage')`);
    await capture("retry");
    await click('input[aria-label="Search pull requests"]');
    await win.webContents.insertText("author:someone is:merged");
    await wait(
      `document.body.innerText.includes('Results') && document.querySelectorAll('.pull-request-row').length===1`,
    );
    await capture("qualified-search");
    const last = calls.findLast((value: any) => value.type === "inbox") as any;
    if (
      last.filters.lifecycle !== "all" ||
      last.filters.rawQuery !== "author:someone is:merged"
    )
      throw new Error("Query qualifiers did not reach transport");
    if (errors.length) throw new Error(errors.join("\n"));
    await writeFile(
      join(output, "result.json"),
      JSON.stringify(
        {
          checkpoints,
          errors,
          calls,
          state: await js("window.pullRequestsState()"),
        },
        null,
        2,
      ),
    );
    win.destroy();
    app.exit(0);
  } catch (error) {
    await writeFile(
      join(output, "failure.json"),
      JSON.stringify(
        {
          error: String(error),
          stack: (error as Error).stack,
          errors,
          checkpoints,
          calls,
        },
        null,
        2,
      ),
    );
    win?.destroy();
    app.exit(1);
  }
}
void run().catch((error) => {
  console.error(error);
  app.exit(1);
});
