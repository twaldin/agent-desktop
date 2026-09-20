import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { build } from "vite";

const root = resolve(import.meta.dir, "../../.."),
  output = resolve(process.argv[2] ?? ".data/context-maintenance-app-001");
await mkdir(output, { recursive: true });
if ((await readdir(output)).length)
  throw new Error("Refusing to overwrite prior fixture evidence.");
const sourcePaths = [
  "apps/desktop/src/renderer/App.tsx", "apps/desktop/src/renderer/SessionUsagePanel.tsx", "apps/desktop/src/renderer/session-usage-state.ts", "apps/desktop/src/renderer/session-usage.css",
  "apps/desktop/src/main/host-transport.ts", "apps/desktop/src/main/command-endpoints.ts", "apps/desktop/src/main/session-usage-transport.ts",
  "apps/host/src/server.ts", "apps/host/src/session-usage.ts", "apps/host/src/session-usage-http.ts", "apps/host/src/session-reset-admission.ts",
  "apps/host/src/omp/session-usage.ts", "apps/host/src/omp/runtime.ts", "apps/host/src/omp-workers/runtime.ts", "apps/host/src/omp-workers/entry.ts", "apps/host/src/omp-workers/protocol.ts",
  "packages/shared/src/protocol.ts", "packages/shared/src/session-usage.ts", "packages/shared/src/session-usage-validation.ts",
  "docs/native-context-maintenance.md",
  ...(await readdir(import.meta.dir)).map(name => `scripts/acceptance/context-maintenance-app/${name}`),
].sort();
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      sourcePaths.map(async (name) => [
        name,
        createHash("sha256")
          .update(await readFile(join(root, name)))
          .digest("hex"),
      ]),
    ),
  );
const before = await hashes();
await writeFile(
  join(output, "source-before.json"),
  JSON.stringify(before, null, 2),
);
const fixture = await realpath(
    await mkdtemp(join(tmpdir(), "agent-desktop-context-maintenance-app-")),
  ),
  bin = join(fixture, "bin");
await mkdir(bin, { recursive: true });
const host = Bun.spawn(
  [process.execPath, join(import.meta.dir, "host.ts"), fixture],
  {
    env: {
      HOME: fixture,
      PATH: `${bin}:${process.env.PATH}`,
      TMPDIR: tmpdir(),
      PI_CODING_AGENT_DIR: join(fixture, "agent"),
      CONTEXT_MAINTENANCE_FIXTURE_DIRECTORY: fixture,
      PI_DISABLE_DOTENV: "1",
      TERM: "dumb",
      AGENT_DESKTOP_NATIVE_TERMINALS: "0",
    },
    stdin: "pipe",
    stdout: Bun.file(join(output, "host.log")),
    stderr: Bun.file(join(output, "host-errors.log")),
  },
);
let electron: Bun.Subprocess | undefined;
try {
  const deadline = Date.now() + 40_000;
  while (!(await Bun.file(join(fixture, "connection.json")).exists())) {
    if (host.exitCode !== null || Date.now() > deadline)
      throw new Error("Host startup failed.");
    await Bun.sleep(100);
  }
  const connection = JSON.parse(
    await readFile(join(fixture, "connection.json"), "utf8"),
  );
  const command = async (command: unknown) => {
    const response = await fetch(`${connection.origin}/v1/commands`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: crypto.randomUUID(), command }),
    });
    const body = (await response.json()) as any;
    if (!response.ok || !body.ok) throw new Error(JSON.stringify(body));
    return body.value;
  };
  // The host fixture creates and seeds the real native session before publishing connection.json.
  await writeFile(
    join(output, "index.html"),
    `<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module" src="${relative(output, join(import.meta.dir, "browser.tsx"))}"></script>`,
  );
  await build({
    configFile: join(root, "apps/desktop/vite.config.ts"),
    root: output,
    logLevel: "warn",
    build: { outDir: join(output, "web"), emptyOutDir: true },
  });
  const compiled = await Bun.build({
    entrypoints: [join(import.meta.dir, "main.ts")],
    outdir: output,
    naming: "main.mjs",
    target: "node",
    format: "esm",
    external: ["electron"],
  });
  if (!compiled.success) throw new Error(compiled.logs.join("\n"));
  await writeFile(
    join(output, "preload.cjs"),
    `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('contextMaintenanceAppFixture',{save:value=>ipcRenderer.sendSync('context-maintenance-app-save',value),call:(method,args)=>ipcRenderer.invoke('context-maintenance-app-call',method,args),subscribe:listener=>{const handler=(_event,value)=>listener(value);ipcRenderer.on('context-maintenance-app-event',handler);return()=>ipcRenderer.removeListener('context-maintenance-app-event',handler);}});`,
  );
  electron = Bun.spawn(
    [
      process.execPath,
      join(root, "node_modules/electron/cli.js"),
      join(output, "main.mjs"),
      output,
      fixture,
    ],
    {
      stdout: Bun.file(join(output, "electron.log")),
      stderr: Bun.file(join(output, "electron-errors.log")),
    },
  );
  const timer = setTimeout(() => electron!.kill("SIGTERM"), 90_000),
    code = await electron.exited;
  clearTimeout(timer);
  if (code) throw new Error(`Electron flow failed (${code}); see ${output}`);
} finally {
  if (electron?.exitCode === null) {
    electron.kill("SIGTERM");
    await electron.exited;
  }
  if (host.exitCode === null) {
    host.stdin.write("stop\n");
    host.stdin.end();
  }
  const timer = setTimeout(() => host.kill("SIGKILL"), 15_000),
    hostExit = await host.exited;
  clearTimeout(timer);
  const after = await hashes();
  await writeFile(
    join(output, "source-after.json"),
    JSON.stringify(after, null, 2),
  );
  await writeFile(
    join(output, "cleanup.json"),
    JSON.stringify({ hostExit, electronExit: electron?.exitCode, fixture }),
  );
  for (const name of ["worker-starts.jsonl", "provider-requests.jsonl", "held-provider.jsonl", "provider-aborts.jsonl"]) {
    if (await Bun.file(join(fixture, name)).exists()) await copyFile(join(fixture, name), join(output, name));
  }
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("Relevant source changed during the fixture.");
  if (hostExit === 0 && electron?.exitCode === 0) await rm(fixture, { recursive: true, force: true });
  else throw new Error(`Owned process failed; isolated files retained at ${fixture}.`);
}
