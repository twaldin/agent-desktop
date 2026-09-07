import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const repo = resolve(import.meta.dir, "../..");
const output = resolve(process.argv[2] ?? `.data/directory-add-menu-${Date.now()}`);
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error("Output must be empty");
await writeFile(join(output, "index.html"), `<html><body><div id="root"></div><script type="module" src="${join(import.meta.dir, "directory-add-menu-browser.tsx")}"></script></body></html>`);
await build({ configFile: false, root: output, plugins: [react(), tailwindcss()], base: "./", build: { outDir: join(output, "web"), rollupOptions: { input: join(output, "index.html") } } });
const electron = Bun.spawn([process.execPath, join(repo, "node_modules/electron/cli.js"), join(import.meta.dir, "directory-add-menu-electron.cjs"), output], {
  cwd: repo,
  env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, PI_DISABLE_DOTENV: "1" },
  stdout: Bun.file(join(output, "electron.log")), stderr: Bun.file(join(output, "electron-errors.log")),
});
const code = await electron.exited;
const result = await Bun.file(join(output, "result.json")).json();
result.scope = "Production NativePluginDirectory and DirectoryAddMenu in hidden Electron with a controlled read-only bridge. Native host, main/preload, provider, OS-window, and pixel parity are outside this focused interaction proof.";
result.passed &&= code === 0;
await writeFile(join(output, "result.json"), JSON.stringify(result, null, 2));
await rm(join(output, "profile"), { recursive: true, force: true });
if (!result.passed) throw new Error(`Directory Add menu acceptance failed at ${result.step}: ${result.error}`);
console.log(JSON.stringify({ passed: true, output }));
