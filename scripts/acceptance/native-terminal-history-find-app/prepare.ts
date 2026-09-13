import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { verifyTmuxBundle } from "../../../apps/host/src/terminals/bundle";

// Main-only finite preparation. Never builds, starts a host/window, or reads a personal profile.
const root = resolve(process.argv[2] ?? ""), evidence = resolve(process.argv[3] ?? ""), repo = resolve(import.meta.dir, "../../..");
if (!process.argv[2] || !process.argv[3] || !basename(root).startsWith("native-history-find-") || root === evidence
  || process.env.HOME !== root || process.env.PI_CODING_AGENT_DIR !== join(root, "agent")
  || process.env.AGENT_DESKTOP_DATA_DIR !== join(root, "host") || process.env.AGENT_DESKTOP_PROFILE_DIR !== join(root, "desktop")
  || process.env.PI_DISABLE_DOTENV !== "1" || process.env.PATH?.split(":")[0] !== join(root, "bin")) throw new Error("Use a fresh native-history-find-* HOME, separate evidence directory and exact isolated paths/private PATH.");
const mode = process.env.NATIVE_FIND_MODE ?? "full";
if (mode !== "full" && mode !== "capture-sequencing" && mode !== "live-find") throw new Error("NATIVE_FIND_MODE must be full, capture-sequencing or live-find.");
const osUser = userInfo(), username = execFileSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).trim();
if (process.env.USER !== username || process.env.LOGNAME !== username) throw new Error("USER and LOGNAME must match the observed OS user; record rather than mask OS metadata.");
const bun = process.env.NATIVE_FIND_BUN, bundlePath = process.env.NATIVE_FIND_TMUX_BUNDLE;
if (!bun || !isAbsolute(bun) || !bundlePath || !isAbsolute(bundlePath)) throw new Error("Main must supply verified absolute NATIVE_FIND_BUN and NATIVE_FIND_TMUX_BUNDLE paths.");
const inspector = process.env.NATIVE_FIND_INSPECTOR, yabai = process.env.NATIVE_FIND_YABAI;
if (!inspector || !isAbsolute(inspector) || !yabai || !isAbsolute(yabai)) throw new Error("Main must supply verified absolute native inspector and yabai paths.");
const bundle = verifyTmuxBundle(bundlePath);
for (const directory of [root, evidence]) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).length) throw new Error("Preparation refuses non-empty profiles or evidence directories.");
}
for (const name of ["agent", "host", "desktop", "project", "bin"]) await mkdir(join(root, name), { mode: 0o700 });
const tailscale = "#!/bin/sh\nprintf '%s\\n' 'Tailscale is refused by the isolated native history Find fixture.' >&2\nexit 1\n";
await writeFile(join(root, "bin/tailscale"), tailscale, { flag: "wx", mode: 0o700 });
await chmod(join(root, "bin/tailscale"), 0o700);
const hostEntry = join(import.meta.dir, "host.ts");
const guardedBun = join(root, "bin/guarded-bun");
await writeFile(guardedBun, '#!/bin/sh\nset -eu\n: "${NATIVE_FIND_BUN:?}"\n: "${NATIVE_FIND_HOST_ENTRY:?}"\nexec "$NATIVE_FIND_BUN" --no-env-file "$NATIVE_FIND_HOST_ENTRY" "$HOME"\n', { flag: "wx", mode: 0o700 });
await writeFile(join(root, "agent/config.yml"), "extensions: []\nretry:\n  enabled: false\n", { flag: "wx", mode: 0o600 });
execFileSync("/usr/bin/git", ["init", "--quiet", join(root, "project")]);
const source = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
const sourcePaths = ["apps/desktop/src/renderer/NativeTerminalPanel.tsx", "apps/desktop/src/renderer/native-terminal-panel.css", "apps/desktop/src/renderer/native-terminal-history-find.ts", "apps/desktop/src/renderer/native-terminal-history-find.test.ts",
  ...["prepare.ts", "host.ts", "worker.ts", "electron.cjs", "emit-history.sh", "cases.json", "native-inspect.swift"].map(name => `scripts/acceptance/native-terminal-history-find-app/${name}`)];
const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async name => [name, createHash("sha256").update(await readFile(join(repo, name))).digest("hex")])));
const helperHashes = { inspector: { path: inspector, sha256: createHash("sha256").update(await readFile(inspector)).digest("hex") }, yabai: { path: yabai, sha256: createHash("sha256").update(await readFile(yabai)).digest("hex") } };
const owner = { kind: "native-history-find", mode, root, evidence, repo, source, hostEntry, bundle: { directory: bundle.directory, digest: bundle.digest },
  osUser, username, helperHashes, environment: { HOME: root, USER: process.env.USER, LOGNAME: process.env.LOGNAME, SHELL: process.env.SHELL, LANG: process.env.LANG, PATH: process.env.PATH },
  tailscaleSha256: createHash("sha256").update(tailscale).digest("hex"), guardedBunSha256: createHash("sha256").update(await readFile(guardedBun)).digest("hex"),
  bunSha256: createHash("sha256").update(await readFile(bun)).digest("hex"), sourceHashes };
await writeFile(join(root, "fixture-owner.json"), JSON.stringify(owner, null, 2), { flag: "wx", mode: 0o600 });
await writeFile(join(evidence, "prepared.json"), JSON.stringify(owner, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ ready: true, mode, root, evidence, source, bundleDigest: bundle.digest, hostEntry,
  next: "Main starts host.ts and electron.cjs under hub only after source gates and an explicit native lease; retain this complete isolated environment." }));
