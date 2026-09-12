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
  output = resolve(process.argv[2] ?? ".data/pull-requests-app-001");
await mkdir(output, { recursive: true });
if ((await readdir(output)).length)
  throw new Error("Refusing to overwrite prior fixture evidence.");
const sourcePaths = [
  "apps/desktop/src/main/pull-request-write-transport.ts",
  "apps/desktop/src/main/pull-request-write-preload.ts",
  "apps/desktop/src/pull-request-composer-state.ts",
  "apps/desktop/src/renderer/PullRequestComposer.tsx",
  "apps/desktop/src/renderer/pull-request-composers.ts",
  "apps/desktop/src/renderer/pull-requests.css",
  "apps/desktop/src/renderer/window-view-state.ts",
  "apps/host/src/store.ts",
  "apps/host/src/pull-request-write-records.ts",
  "packages/shared/src/pull-request-write.ts",
  "apps/desktop/src/main/command-endpoints.ts",
  "apps/desktop/src/main/host-transport.ts",
  "apps/desktop/src/main/pull-requests-transport.ts",
  "apps/desktop/src/main/window-state.ts",
  "apps/desktop/src/renderer/App.tsx",
  "apps/desktop/src/renderer/PullRequestsPage.tsx",
  "apps/desktop/src/renderer/pull-request-cache.ts",
  "apps/desktop/src/renderer/pull-request-pages.ts",
  "apps/desktop/src/renderer/pull-request-query.ts",
  "apps/desktop/src/window-state.ts",
  "apps/host/src/pull-requests-http.ts",
  "apps/host/src/pull-requests.ts",
  "apps/host/src/server.ts",
  "packages/shared/src/protocol.ts",
  "packages/shared/src/pull-requests.ts",
  ...(await readdir(import.meta.dir)).map(
    (name) => `scripts/acceptance/pull-requests-app/${name}`,
  ),
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
    await mkdtemp(join(tmpdir(), "agent-desktop-pull-requests-app-")),
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
  const project = await command({
      type: "project.add",
      path: join(fixture, "project"),
      name: "Pull request workspace",
    }),
    session = await command({ type: "session.create", projectId: project.id });
  await writeFile(
    join(fixture, "context.json"),
    JSON.stringify({ projectId: project.id, sessionId: session.id }),
  );
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
    `const{contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('pullRequestsAppFixture',{save:value=>ipcRenderer.sendSync('pull-requests-app-save',value),call:(method,args)=>ipcRenderer.invoke('pull-requests-app-call',method,args),subscribe:listener=>{const handler=(_event,value)=>listener(value);ipcRenderer.on('pull-requests-app-event',handler);return()=>ipcRenderer.removeListener('pull-requests-app-event',handler);}});`,
  );
  electron = Bun.spawn(
    [
      process.execPath,
      join(root, "node_modules/electron/cli.js"),
      join(output, "main.mjs"),
      output,
      fixture,
      ...(process.argv.includes("--writes") ? ["--writes"] : []),
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
  if (await Bun.file(join(fixture, "gh-calls.jsonl")).exists())
    await copyFile(
      join(fixture, "gh-calls.jsonl"),
      join(output, "gh-calls.jsonl"),
    );
  if (await Bun.file(join(fixture, "gh-written.jsonl")).exists()) await copyFile(join(fixture, "gh-written.jsonl"), join(output, "gh-written.jsonl"));
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("Relevant source changed during the fixture.");
  if (hostExit === 0) await rm(fixture, { recursive: true, force: true });
  else throw new Error("Host cleanup failed; isolated files retained.");
}
