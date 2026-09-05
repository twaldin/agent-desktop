import { join } from "node:path";

const root = join(import.meta.dir, "..");
const build = Bun.spawn([process.execPath, "scripts/build.ts", "--main-only"], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await build.exited) throw new Error("Desktop main build failed.");
const vite = Bun.spawn([process.execPath, "--bun", "vite", "--config", "apps/desktop/vite.config.ts"], { cwd: root, stdout: "inherit", stderr: "inherit" });
const deadline = Date.now() + 20_000;
let ready = false;
while (Date.now() < deadline && vite.exitCode === null) {
  try { if ((await fetch("http://127.0.0.1:5173")).ok) { ready = true; break; } } catch {}
  await Bun.sleep(100);
}
if (!ready) { vite.kill(); throw new Error("Renderer did not start."); }
const electron = Bun.spawn([process.execPath, join(root, "node_modules/electron/cli.js"), "apps/desktop"], {
  cwd: root, stdout: "inherit", stderr: "inherit",
  env: { ...process.env, AGENT_DESKTOP_PROJECT_ROOT: root, AGENT_DESKTOP_BUN: process.execPath,
    AGENT_DESKTOP_DATA_DIR: join(root, ".data/dev"), AGENT_DESKTOP_RENDERER_URL: "http://127.0.0.1:5173" },
});
const stop = () => { electron.kill(); vite.kill(); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
try { process.exitCode = await electron.exited; } finally { vite.kill(); }
