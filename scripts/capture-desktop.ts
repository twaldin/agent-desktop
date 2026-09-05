import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "..");
const output = resolve(process.argv[2] ?? ".data/visual-captures");
const bundle = process.argv[3] ? resolve(process.argv[3]) : undefined;
if (!bundle) {
  const build = Bun.spawn([process.execPath, "scripts/build.ts"], { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await build.exited) throw new Error("Desktop build failed.");
}
const profile = await mkdtemp(join(tmpdir(), "agent-desktop-capture-"));
try {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENT_DESKTOP_DATA_DIR: join(root, ".data/dev"), AGENT_DESKTOP_PROFILE_DIR: profile,
    AGENT_DESKTOP_CAPTURE: output, AGENT_DESKTOP_RENDERER_URL: "" };
  if (bundle) { delete env.AGENT_DESKTOP_PROJECT_ROOT; delete env.AGENT_DESKTOP_BUN; }
  else { env.AGENT_DESKTOP_PROJECT_ROOT = root; env.AGENT_DESKTOP_BUN = process.execPath; }
  const electron = Bun.spawn(bundle ? [join(bundle, "Contents/MacOS/Agent Desktop")] : [process.execPath, join(root, "node_modules/electron/cli.js"), "apps/desktop"], {
    cwd: root, stdout: "inherit", stderr: "inherit",
    env,
  });
  if (await electron.exited) throw new Error("Desktop capture failed.");
  console.log(`Own-app captures and measurements: ${output}`);
} finally { await rm(profile, { recursive: true, force: true }); }
