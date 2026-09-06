import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/** Development overrides never select executable/code paths in a packaged desktop. */
export function resolveHostLaunch(options: {
  isPackaged: boolean;
  resourcesPath: string;
  homeDirectory: string;
  environment: { AGENT_DESKTOP_BUN?: string; AGENT_DESKTOP_PROJECT_ROOT?: string };
}): { bun: string; entry: string } {
  const packagedEntry = join(options.resourcesPath, "host/apps/host/src", options.isPackaged ? "packaged-entry.ts" : "server.ts");
  const bun = options.isPackaged ? join(options.resourcesPath, "runtime/bun")
    : options.environment.AGENT_DESKTOP_BUN || (existsSync(packagedEntry)
      ? join(options.resourcesPath, "runtime/bun") : join(options.homeDirectory, ".bun/bin/bun"));
  const entry = !options.isPackaged && options.environment.AGENT_DESKTOP_PROJECT_ROOT
    ? join(options.environment.AGENT_DESKTOP_PROJECT_ROOT, "apps/host/src/server.ts") : packagedEntry;
  if (!isAbsolute(bun) || !isAbsolute(entry)) throw new Error("Host runtime paths must be absolute.");
  try {
    if (!statSync(bun).isFile() || !statSync(entry).isFile()) throw new Error("Missing runtime file");
    if (options.isPackaged) {
      const root = realpathSync(options.resourcesPath);
      for (const path of [bun, entry]) {
        const child = relative(root, realpathSync(path));
        if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new Error("Runtime escaped its bundle");
      }
    }
  } catch {
    throw new Error("The host runtime is missing or outside its app bundle. Build or reinstall Agent Desktop.");
  }
  return { bun, entry };
}
