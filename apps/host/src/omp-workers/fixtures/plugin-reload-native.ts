import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.env.FIXTURE_ROOT;
if (!root) throw new Error("FIXTURE_ROOT required");
process.env.XDG_DATA_HOME = path.join(root, "xdg");
process.env.XDG_STATE_HOME = path.join(root, "xdg");
process.env.XDG_CACHE_HOME = path.join(root, "xdg");
process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");

const dirs = await import("@oh-my-pi/pi-utils");
dirs.refreshDirsFromEnv();
const { dispatchNativePrompt } = await import("../../omp/commands");
const pluginsDir = dirs.getPluginsDir();
await mkdir(pluginsDir, { recursive: true });
const registryPath = path.join(pluginsDir, "installed_plugins.json");
const entry = { scope: "user", installPath: path.join(root, "installed", "fixture"), version: "1.0.0", installedAt: "2026-09-19T00:00:00.000Z", lastUpdated: "2026-09-19T00:00:00.000Z", enabled: true };
await writeFile(registryPath, `${JSON.stringify({ version: 2, plugins: { "fixture@local": [entry] } }, null, 2)}\n`);

const outputs: string[] = [];
const session = {
  extensionRunner: undefined, customCommands: [], slashCommands: [], promptTemplates: [], isCompacting: false, isAborting: false,
  sessionManager: { getCwd: () => root, appendCustomEntry: (_type: string, value: { output: string }) => { outputs.push(value.output); return `entry-${outputs.length}`; } },
  settings: {}, prompt: async () => { throw new Error("model must not run"); },
};
let reloads = 0;
const common = {
  reloadMcp: async () => {}, reconnectMcp: async () => { throw new Error("unused"); }, inspectMcp: () => { throw new Error("unused"); }, authorizeMcp: async () => { throw new Error("unused"); },
};
const bridges = { ...common, reloadPlugins: async () => { reloads++; } };
const disabled = await dispatchNativePrompt(session as never, "/plugins disable fixture@local", undefined, undefined, bridges);
const disabledRegistry = JSON.parse(await readFile(registryPath, "utf8"));
const enabled = await dispatchNativePrompt(session as never, "/plugins enable fixture@local", undefined, undefined, bridges);
const enabledRegistry = JSON.parse(await readFile(registryPath, "utf8"));
const failed = await dispatchNativePrompt(session as never, "/plugins disable fixture@local", undefined, undefined, {
  ...common,
  reloadPlugins: async () => { throw new Error("controlled reload failure"); },
});
const failedRegistry = JSON.parse(await readFile(registryPath, "utf8"));

process.stdout.write(JSON.stringify({
  disabled: disabled.output, disabledValue: disabledRegistry.plugins["fixture@local"][0].enabled,
  enabled: enabled.output, enabledValue: enabledRegistry.plugins["fixture@local"][0].enabled,
  failed: failed.output, failedValue: failedRegistry.plugins["fixture@local"][0].enabled,
  reloads, outputs,
}));
