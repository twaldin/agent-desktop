import { app, BrowserWindow, Menu, ipcMain } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { requestVersionedCommand } from "../../apps/desktop/src/main/command-endpoints";
import { requestHost } from "../../apps/desktop/src/main/host-transport";

const output = process.argv[2]!, fixture = process.argv[3]!;
const connection = JSON.parse(readFileSync(join(fixture, "fixture-connection.json"), "utf8"));
app.setPath("userData", join(fixture, "electron-profile"));
const observed: { method: string; args: unknown[]; result?: unknown; error?: string }[] = [];
const http = (path: string, body?: unknown): Promise<any> => requestHost(connection, path, body);
async function run() {
await app.whenReady(); Menu.setApplicationMenu(null);
const window = new BrowserWindow({ show: false, width: 1480, height: 1000, webPreferences: { preload: join(output, "preload.cjs"), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
ipcMain.handle("fixture-call", async (_event, method: string, args: any[]) => {
  const observation = { method, args } as (typeof observed)[number];
  if (["command", "respondInteraction"].includes(method)) observed.push(observation);
  try {
    let result: unknown;
    switch (method) {
      case "getState": result = await http("/v1/state"); break;
      case "getHosts": result = await http("/v1/peers"); break;
      case "getPreferences": result = await http("/v1/preferences"); break;
      case "getTheme": result = await http("/v1/theme"); break;
      case "getComposerCatalog": result = await http("/v1/models/composer", { target: args[0], refresh: args[1] }); break;
      case "getSessionControls": result = await http(`/v1/sessions/${encodeURIComponent(args[0])}/controls`); break;
      case "getInteractions": result = await http(`/v1/sessions/${encodeURIComponent(args[0])}/interactions`); break;
      case "respondInteraction": result = await http(`/v1/sessions/${encodeURIComponent(args[0])}/interactions`, { interactionId: args[1], response: args[2] }); break;
      case "getMessages": result = await http(`/v1/sessions/${encodeURIComponent(args[0])}/messages`); break;
      case "command": result = await requestVersionedCommand(http, args[0]); break;
      case "getLocalFonts": result = []; break; // Font enumeration is outside this renderer/host fixture.
      case "getThemeBackground": result = null; break;
      case "applyWindowTheme": window.setBackgroundColor(args[0].backgroundColor); break;
      default: throw new Error(`Unimplemented fixture bridge call: ${method}`);
    }
    if (["command", "respondInteraction"].includes(method)) observation.result = result;
    return result;
  } catch (error) { observation.error = String(error); throw error; }
});
const socket = new WebSocket(connection.origin.replace("http:", "ws:") + "/v1/events?after=0", ["agent-desktop", connection.token]);
socket.addEventListener("message", event => { if (!window.isDestroyed()) window.webContents.send("fixture-event", JSON.parse(String(event.data))); });
const result: Record<string, unknown> = { passed: false, scope: "Production App + actual isolated native host and OMP worker through an acceptance-only IPC/HTTP adapter; provider fetch disabled.", electron: process.versions.electron, captures: [] };
const capture = async (name: string) => {
  const metadata = await window.webContents.executeJavaScript("appStartupGeometry()");
  const file = join(output, `${name}.png`); writeFileSync(file, (await window.webContents.capturePage()).toPNG());
  (result.captures as unknown[]).push({ name, file, zoom: window.webContents.getZoomFactor(), ...metadata });
};
try {
  await window.loadFile(join(output, "web/index.html"));
  result.ready = await window.webContents.executeJavaScript("prepareAppStartupAcceptance()");
  await capture("wide-permissions");
  result.keyboard = await window.webContents.executeJavaScript("checkIntegratedAppShortcuts()");
  result.pending = await window.webContents.executeJavaScript("startNativeAppQuestion()");
  await capture("wide-native-startup-question");
  for (const [name, width, height, zoom] of [["narrow-native-startup-question", 860, 900, 1], ["zoom-native-startup-question", 1060, 1000, 1.25]] as const) {
    window.setContentSize(width, height); window.webContents.setZoomFactor(zoom);
    await new Promise(resolve => setTimeout(resolve, 150)); await capture(name);
  }
  result.accepted = await window.webContents.executeJavaScript("answerNativeAppQuestion()");
  window.setContentSize(1480, 968); window.webContents.setZoomFactor(1);
  result.conflict = await window.webContents.executeJavaScript("checkNativeDraftConflict()");
  await capture("wide-selection-conflict");
  result.olderHost = await window.webContents.executeJavaScript("finishConflictAndCheckOlderHost()");
  await capture("controlled-unsupported-permission-capability");
  result.state = await http("/v1/state");
  result.calls = observed;
  result.passed = true;
} catch (error) {
  result.error = String(error); result.calls = observed;
  result.dom = await window.webContents.executeJavaScript("document.body.innerText").catch(() => "Unavailable");
  await capture("failure").catch(() => {});
} finally {
  result.state ??= await http("/v1/state").catch(() => undefined);
  writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2));
  socket.close(); console.log(JSON.stringify({ passed: result.passed, error: result.error, captures: (result.captures as unknown[]).length })); app.exit(result.passed ? 0 : 1);
}
}
void run().catch(error => { console.error(error); app.exit(1); });
