import { mkdir, writeFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createRequire } from "node:module";
import { build } from "vite";
import react from "@vitejs/plugin-react";
const root = resolve(import.meta.dir, "../../..");
const out = resolve(process.argv[2] ?? `.data/accounts-settings-fixture-${Date.now()}`);
await mkdir(out, { recursive: true });
await writeFile(join(out, "index.html"), '<!doctype html><div id="root"></div><script type="module" src="/scripts/acceptance/accounts-settings-fixture/browser.tsx"></script>');
await build({ configFile: false, plugins: [react()], root, base: "./", build: { outDir: join(out, "web"), rollupOptions: { input: join(out, "index.html") } } });
await writeFile(join(out, "preload.cjs"), `const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('accountsFixture', {
 invoke: (method, args) => ipcRenderer.invoke('accounts-fixture', method, args),
 subscribe: listener => { const callback = (_event, value) => listener(value); ipcRenderer.on('accounts-fixture-event', callback); return () => ipcRenderer.removeListener('accounts-fixture-event', callback); }
});`);
const html = (await readdir(join(out, "web"), { recursive: true })).find(path => path.endsWith("index.html"));
if (!html) throw new Error("Missing fixture HTML");
const electron = createRequire(import.meta.url)("electron") as string;
const proc = Bun.spawn([electron, resolve(import.meta.dir, "electron.cjs"), out, join(out, "web", html)], { stdout: "inherit", stderr: "inherit" });
const timeout = setTimeout(() => proc.kill("SIGTERM"), 60_000);
try { const exit = await proc.exited; console.log(await Bun.file(join(out, "result.json")).text()); if (exit !== 0) process.exitCode = 1; }
finally { clearTimeout(timeout); if (proc.exitCode === null) { proc.kill("SIGTERM"); await proc.exited; } }
