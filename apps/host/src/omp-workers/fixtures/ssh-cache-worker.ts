// Test observation only: native session/IPC code runs unchanged. SIGUSR2 reads
// the same SDK capability cache without resetting it or executing an SSH tool.
import { writeFile } from "node:fs/promises";
import path from "node:path";
const cwd = process.env.SSH_CACHE_CWD!, output = process.env.SSH_CACHE_OUTPUT!, home = process.env.HOME!;
if (!cwd?.startsWith(home + path.sep) || !output?.startsWith(home + path.sep)) throw new Error("Isolated SSH cache fixture paths required");
let sequence = 0;
process.on("SIGUSR2", () => { void (async () => {
  const { loadCapability } = await import("@oh-my-pi/pi-coding-agent/discovery");
  const result = await loadCapability<import("@oh-my-pi/pi-coding-agent/capability/ssh").SSHHost>("ssh", { cwd });
  await writeFile(output, JSON.stringify({ sequence: ++sequence, pid: process.pid, hosts: result.items.map(item => ({ name: item.name, host: item.host })) }));
})().catch(async error => { await writeFile(output, JSON.stringify({ error: String(error) })); }); });
await import("./no-provider-worker");
