import { lstatSync } from "node:fs";
import { join } from "node:path";
import { NativeTerminalStore } from "../apps/host/src/terminals/native-store";

/** A dead host locator does not prove that its detached native panes have exited. */
export function assertNoNativeTerminalOwnership(dataDirectory: string, options: { allowRetainedFinalScreens?: boolean } = {}): void {
  const directory = join(dataDirectory, "native-terminals-v1");
  try { lstatSync(join(directory, "catalog.json")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  const catalog = new NativeTerminalStore(directory).read()!;
  if (catalog.terminals.some(({ info }) => !["exited", "error", "interrupted"].includes(info.status)
    || !Number.isFinite(info.exitedAt))) {
    throw new Error("A native terminal may still own a running pane. Reopen its current host version and close the terminal before changing the installation.");
  }
  if (!options.allowRetainedFinalScreens && catalog.serverPid) {
    throw new Error("The private native server still has recorded ownership. Reopen and cleanly stop its current host version before changing the installation.");
  }
}

export async function assertNoLiveTerminals(connection: { origin: string; token: string }, dataDirectory?: string): Promise<void> {
  for (const version of ["v1", "v2"]) {
    const response = await fetch(`${connection.origin}/${version}/terminals/query`, {
      method: "POST", headers: { Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: "list" }), signal: AbortSignal.timeout(3000),
    });
    if (response.status === 404) continue; // A preceding release may not expose this protocol.
    if (version === "v2" && response.status === 503 && dataDirectory) {
      const unavailable = await response.clone().json().catch(() => undefined) as { error?: { code?: string } } | undefined;
      if (unavailable?.error?.code === "NATIVE_TERMINAL_BUNDLE_MISSING") {
        // A source host without its runtime never opened the native manager.
        // Still require the durable catalog to prove there is no detached owner.
        assertNoNativeTerminalOwnership(dataDirectory);
        continue;
      }
    }
    if (!response.ok) throw new Error("Could not check active terminals. Reconnect the current host before changing the installation.");
    const result = await response.json() as { type?: string; terminals?: Array<{ status: string; exitedAt?: number }> };
    if (result.type !== "list" || !Array.isArray(result.terminals)) throw new Error("The host returned an invalid terminal catalog.");
    if (result.terminals.some(terminal => terminal.exitedAt === undefined)) throw new Error("A host terminal is open. Close it before changing the installation.");
  }
}
