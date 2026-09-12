/** Captured parent init -> actual entry init -> native profile consumers.
 * Spawn, imports, Settings/auth and SessionManager are controlled, never loaded. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { localEnvironmentForWorker } from "../../apps/host/src/local-environments/environment";

const parentPath = process.env.PROFILE_PARENT ?? path.resolve("apps/host/src/omp-workers/runtime.ts");
const paths = { parent: parentPath, entry: "apps/host/src/omp-workers/entry.ts", native: "apps/host/src/omp/runtime.ts", owner: "apps/host/src/omp-browser/owner.ts" };
const sources = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, file]) => [key, await readFile(file, "utf8")]))) as Record<keyof typeof paths, string>;
const selections: Record<string, string> = {};
function pick(name: string, value: string, start: string, end?: string) {
  const a = value.indexOf(start), b = end ? value.indexOf(end, a) : value.length;
  assert(a >= 0 && b > a, name); return selections[name] = value.slice(a, b);
}
const transpile = (value: string) => new Bun.Transpiler({ loader: "ts" }).transformSync(value.replace(/^export /gm, ""));
const parent = pick("parent", sources.parent, "export class WorkerRuntime");
const client = pick("client", sources.parent, "export class WorkerClient", "/** One native OMP process");
const init = pick("entryInit", sources.entry, '      case "init": {', '      case "generateCommit": {');
const constructor = pick("nativeConstructor", sources.native, "  constructor(options: { agentDir?: string } = {})", "  async #context(");
const context = pick("nativeContext", sources.native, "  async #context(", "  #assertActive(): void");
const loader = pick("browserLoader", sources.owner, "async function loadNativeOwner(", "/** One isolated worker");
const replaceOnce = (value: string, from: string, to: string) => { assert.equal(value.split(from).length, 2); return value.replace(from, to); };
let entryBody = replaceOnce(init, 'await import("../omp")', "await loadOmp()");
entryBody = replaceOnce(entryBody, 'await import("../omp-browser/owner")', "await loadBrowser()");
let loaderBody = replaceOnce(loader, 'await import("@oh-my-pi/pi-coding-agent/tools/browser")', "await loadBrowserTools()");
loaderBody = replaceOnce(loaderBody, 'await import("@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor")', "await loadSupervisor()");
loaderBody = replaceOnce(loaderBody, 'await import("@oh-my-pi/pi-coding-agent/config/settings")', "await loadSettings()");

interface Init { mode: string; agentDir?: string; owner?: { id: string; cwd: string }; options?: { cwd?: string; expectedIdentity?: { id: string; cwd: string } } }
interface Spawn { cwd?: string; env: Record<string, string | undefined>; cmd: string[] }
interface Session { id: string; cwd: string; sessionFile: string }
interface ProfileTrace { settings: Array<{ cwd: string; agentDir?: string }>; invalidated: string[]; models: string[]; auth: string[] }
function harness(agentDir: string | undefined, environmentProfile: string | undefined) {
  const traces: ProfileTrace[] = [], spawns: Spawn[] = [], inits: Init[] = [];
  const env = { PWD: "/daemon", ...(environmentProfile === undefined ? {} : { PI_CODING_AGENT_DIR: environmentProfile }) };
  const ActualClient = new Function("Bun", "path", "fileURLToPath", "getBundledRuntimeRoot", "assertBundledRuntime", "setTimeout", "clearTimeout",
    transpile(client.replaceAll("import.meta.url", JSON.stringify(pathToFileURL(parentPath).href))) + "\nreturn WorkerClient;")(
    { spawn(options: Spawn) { spawns.push(options); return { pid: 123 }; } }, path, fileURLToPath, () => undefined, () => { throw new Error("Unexpected package assertion"); }, () => ({ unref() {} }), () => {},
  ) as new(options: unknown, environment: unknown, cwd?: string) => unknown;

  class Client {
    pid = 123; snapshot?: Session;
    readonly trace: ProfileTrace = { settings: [], invalidated: [], models: [], auth: [] };
    readonly runEntry: (message: { operation: string; args: Init }) => Promise<{ runtime?: { inspect(cwd: string): Promise<unknown> }; session?: Session; browserOwner?: { id: string; cwd: string } }>;
    child?: Awaited<ReturnType<typeof this.runEntry>>;
    constructor(options: unknown, environment: unknown, directory?: string) {
      new ActualClient({ ...(options as object), executablePath: "/controlled/bun" }, environment, directory);
      const trace = this.trace, spawn = spawns.at(-1)!; traces.push(trace);
      const childProcess = { env: { ...spawn.env } };
      const Settings = { async loadReadOnly(input: { cwd: string; agentDir?: string }) { trace.settings.push({ ...input }); return {}; } };
      const Runtime = new Function("path", "getAgentDir", "invalidate", "ModelsConfigFile", "Settings", "discoverAuthStorage", "ModelRegistry", "loadExtensionProviders",
        transpile(`class NativeProfile { #agentDir: string; ${constructor}${context}
          inspect(cwd: string) { return this.#context(cwd, false); }
          async create(options: {cwd: string}) { await this.inspect(options.cwd); return {id:"session",cwd:options.cwd,sessionFile:"/session.jsonl"}; }
          async open(options: {expectedIdentity:{id:string;cwd:string}}) { await this.inspect(options.expectedIdentity.cwd); return {...options.expectedIdentity,sessionFile:"/session.jsonl"}; }
        }`) + "\nreturn NativeProfile;")(
        path, () => childProcess.env.PI_CODING_AGENT_DIR || "/native-default", (file: string) => trace.invalidated.push(file),
        { relocate(file: string) { trace.models.push(file); return { invalidate() {} }; } }, Settings,
        async (profile: string) => { trace.auth.push(profile); return { close() {} }; },
        class { constructor(_auth: unknown, file: string) { trace.models.push(file); } getError() { return undefined; } async hydrateCredentialScopedModelCaches() {} },
        async () => { throw new Error("Unexpected extension load"); },
      );
      const loadOwner = new Function("realpath", "stat", "loadBrowserTools", "loadSupervisor", "loadSettings", transpile(loaderBody) + "\nreturn loadNativeOwner;")(
        async (p: string) => p, async () => ({ isDirectory: () => true }),
        async () => ({ BROWSER_TAB_OWNER_CREATE_VERSION: 1, BROWSER_TAB_CREATE_INITIAL_URL_VERSION: 1, createBrowserTabForOwner() { throw new Error("Unexpected create"); } }),
        async () => ({ releaseTabsForOwner() {} }), async () => ({ Settings }),
      ) as (options: { id: string; cwd: string; agentDir?: string }) => Promise<unknown>;
      class Owner {
        constructor(readonly options: { id: string; cwd: string; agentDir?: string }) {}
        get id() { return this.options.id; } get cwd() { return this.options.cwd; }
        async ready() { await loadOwner(this.options); }
      }
      this.runEntry = new Function("process", "loadOmp", "loadBrowser", transpile(`let runtime, browserOwner, session, initializing=false, stopping=false;
        const emit=()=>{}; const snapshot=()=>session; const respond=()=>{};
        return async function(message) { switch(message.operation) { ${entryBody} } return {runtime,browserOwner,session}; };`))(
        childProcess, async () => ({ OmpRuntime: Runtime }), async () => ({ NativeBrowserOwner: Owner }),
      );
    }
    async request(message: { operation: string; args?: Init | { cwd?: string } }) {
      if (message.operation === "init") {
        const args = message.args as Init; inits.push(args); this.child = await this.runEntry({ operation: "init", args }); this.snapshot = this.child.session;
        return this.child.browserOwner ? { ownerId: this.child.browserOwner.id, cwd: this.child.browserOwner.cwd } : undefined;
      }
      if (message.operation === "listModels") { await this.child?.runtime?.inspect((message.args as { cwd: string }).cwd); return []; }
      return [];
    }
    async close() {} subscribe() { return () => {}; } subscribeFailure() { return () => {}; }
  }
  const Runtime = new Function("WorkerClient", "requireDirectory", "readSessionHeader", "realpath", "path", "localEnvironmentForWorker", transpile(parent) + "\nreturn WorkerRuntime;")(
    Client, async (p: string) => p === "/selected" ? "/final" : p, async () => ({ id: "original", cwd: "/final" }), async (p: string) => p, path, localEnvironmentForWorker,
  ) as new(options: unknown) => { create(input: unknown): Promise<unknown>; open(input: unknown): Promise<unknown>; createBrowserOwner(input: unknown): Promise<unknown>; listModels(cwd: string): Promise<unknown>; dispose(): Promise<void> };
  return { runtime: new Runtime({ agentDir, environment: env }), traces, spawns, inits };
}

const results: { name: string; ok: boolean; error?: string }[] = [];
for (const profile of ["", undefined, "explicit-relative"] as const) for (const environment of [undefined, "environment-relative"] as const) for (const mode of ["create", "open", "browser", "discovery"] as const) {
  const name = `${mode}: option=${JSON.stringify(profile) ?? "absent"}, environment=${environment ?? "default"}`;
  const h = harness(profile, environment), expected = profile ? path.resolve(profile) : environment ? path.resolve(environment) : "/native-default";
  try {
    if (mode === "create") await h.runtime.create({ cwd: "/selected" });
    if (mode === "open") await h.runtime.open({ sessionFile: "/session.jsonl" });
    if (mode === "browser") await h.runtime.createBrowserOwner({ id: "owner", cwd: "/selected" });
    if (mode === "discovery") await h.runtime.listModels("/final");
    const trace = h.traces[0]!;
    assert.equal(trace.settings.length, 1);
    // Omitted browser profile lets native Settings consume the spawn environment.
    assert.equal(trace.settings[0]?.agentDir, mode === "browser" && !profile ? undefined : expected);
    if (mode !== "browser") {
      assert.deepEqual(trace.auth, [expected]);
      assert.deepEqual(trace.models, [path.join(expected, "models.yml"), path.join(expected, "models.yml")]);
      assert.deepEqual(trace.invalidated.slice(0, 2), [path.join(expected, "config.yml"), path.join(expected, "config.yaml")]);
    }
    assert.equal(h.inits[0]?.agentDir, profile ? path.resolve(profile) : undefined);
    assert.equal(h.spawns[0]?.cwd, mode === "discovery" ? undefined : "/final");
    if (profile || environment) assert.equal(h.spawns[0]?.env.PI_CODING_AGENT_DIR, expected);
    results.push({ name, ok: true });
  } catch (error) { results.push({ name, ok: false, error: String(error) }); }
  finally { await h.runtime.dispose(); }
}
console.log(JSON.stringify({ results, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, paths,
  selections: Object.fromEntries(Object.entries(selections).map(([key, value]) => [key, { bytes: Buffer.byteLength(value), sha256: new Bun.CryptoHasher("sha256").update(value).digest("hex") }])),
  limits: "Actual extracted parent/client, entry init, OmpRuntime constructor/context and browser loader; modeled spawn/IPC/imports/native getAgentDir/Settings/auth/ModelRegistry. No SDK, filesystem config/auth access, child process, browser or native execution." }, null, 2));
if (results.some(result => !result.ok)) process.exitCode = 1;
