import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { build } from "vite";
import { account, detail, inbox, summary, page } from "./data";
import {
  PULL_REQUESTS_HOST_HEADER,
  parsePullRequestReadRequest,
  hasRelationshipQualifier,
} from "../../../packages/shared/src/pull-requests";
const root = resolve(import.meta.dir, "../../.."),
  output = resolve(process.argv[2] ?? ".data/pull-requests-electron-001");
await mkdir(output, { recursive: true });
if ((await readdir(output)).length)
  throw new Error("Refusing to overwrite fixture evidence");
const files = [
  "apps/desktop/src/renderer/PullRequestsPage.tsx",
  "apps/desktop/src/renderer/pull-request-icons.tsx",
  "apps/desktop/src/renderer/pull-requests.css",
  "apps/desktop/src/renderer/pull-request-pages.ts",
  "apps/desktop/src/renderer/pull-request-query.ts",
  "apps/desktop/src/renderer/pull-request-cache.ts",
  "apps/desktop/src/main/pull-requests-transport.ts",
  "apps/desktop/src/main/pull-requests-preload.ts",
  "apps/desktop/src/pull-request-window-state.ts",
  "packages/shared/src/pull-requests.ts",
  ...["run.ts", "main.ts", "browser.tsx", "data.ts"].map(
    (name) => `scripts/acceptance/pull-requests/${name}`,
  ),
];
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [
        file,
        createHash("sha256")
          .update(await readFile(join(root, file)))
          .digest("hex"),
      ]),
    ),
  );
const before = await hashes();
await writeFile(join(output, "before.json"), JSON.stringify(before, null, 2));
let holdDetail = false,
  failInbox = false;
const pending: (() => void)[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    if (new URL(request.url).pathname === "/control") {
      const value = (await request.json()) as any;
      if ("holdDetail" in value) holdDetail = value.holdDetail;
      if ("failInbox" in value) failInbox = value.failInbox;
      if (value.releaseDetail) {
        holdDetail = false;
        for (const done of pending.splice(0)) done();
      }
      return new Response("ok");
    }
    const headers = {
      [PULL_REQUESTS_HOST_HEADER]: "host-a",
      "Cache-Control": "no-store",
    };
    if (
      request.headers.get("Authorization") !== "Bearer fixture-only" ||
      request.headers.get(PULL_REQUESTS_HOST_HEADER) !== "host-a"
    )
      return new Response("Unauthorized", { status: 401, headers });
    const input = parsePullRequestReadRequest(await request.json());
    if (input.type === "accounts")
      return Response.json(
        {
          type: "accounts",
          availability: {
            status: "ready",
            accounts: [account],
            activeAccountId: account.id,
            message: null,
          },
        },
        { headers },
      );
    if (input.type === "inbox") {
      if (failInbox)
        return Response.json(
          { error: "Controlled GitHub outage" },
          { status: 503, headers },
        );
      const value = inbox();
      value.filters = input.filters;
      if (hasRelationshipQualifier(input.filters.rawQuery))
        value.sections = [
          { key: "results", items: [summary()], pageInfo: page, error: null },
        ];
      else if (input.filters.view === "authored")
        value.sections = value.sections.filter(
          (section) => section.key === "authored",
        );
      else if (input.filters.view === "reviewing")
        value.sections = value.sections.filter(
          (section) => section.key !== "authored",
        );
      if (input.after)
        value.sections = value.sections.filter(
          (section) => input.after?.[section.key],
        );
      return Response.json(value, { headers });
    }
    if (holdDetail) await new Promise<void>((done) => pending.push(done));
    const value = detail();
    value.summary = summary(input.pullRequest.number);
    return Response.json(value, { headers });
  },
});
let electron: Bun.Subprocess | undefined;
try {
  await writeFile(
    join(output, "endpoint.json"),
    JSON.stringify({
      origin: `http://127.0.0.1:${server.port}`,
      hostId: "host-a",
      token: "fixture-only",
    }),
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
    `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('pullRequestFixture',{call:(...args)=>ipcRenderer.invoke('pr-call',...args)});`,
  );
  electron = Bun.spawn(
    [
      process.execPath,
      join(root, "node_modules/electron/cli.js"),
      join(output, "main.mjs"),
      output,
    ],
    {
      stdout: Bun.file(join(output, "electron.log")),
      stderr: Bun.file(join(output, "electron-errors.log")),
    },
  );
  const timer = setTimeout(() => electron!.kill("SIGTERM"), 90_000),
    code = await electron.exited;
  clearTimeout(timer);
  if (code) throw new Error(`Electron fixture exited ${code}`);
} finally {
  for (const done of pending.splice(0)) done();
  server.stop(true);
  if (electron?.exitCode === null) {
    electron.kill("SIGTERM");
    await electron.exited;
  }
  const after = await hashes();
  await writeFile(join(output, "after.json"), JSON.stringify(after, null, 2));
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("Selected source changed during fixture");
}
