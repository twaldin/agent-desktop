// Actual native session plus a labelled controlled provider. Only this isolated
// session's flush certification can fail; native writes themselves still run.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, SessionManager } from "@oh-my-pi/pi-coding-agent";
import imageProvider from "../omp-workers/fixtures/image-provider";

export default function (pi: ExtensionAPI) {
  imageProvider(pi);
  // Hold actual native admission before agent.prompt, so another HTTP client can
  // save a newer draft before the captured submission obtains its receipt.
  pi.on("before_agent_start", async () => {
    const gates = process.env.IMAGE_CONTRACT_GATES!;
    if (!existsSync(path.join(gates, "hold-admission"))) return;
    writeFileSync(path.join(gates, "admission-started"), "");
    const deadline = Date.now() + 10_000;
    while (!existsSync(path.join(gates, "release-admission"))) {
      if (Date.now() >= deadline) throw new Error("Controlled native HTTP admission gate timed out");
      await Bun.sleep(5);
    }
  });
  const patched = new WeakSet<SessionManager>();
  pi.on("before_agent_start", (_event, context) => {
    const manager = context.sessionManager as SessionManager;
    if (patched.has(manager)) return;
    patched.add(manager);
    const flush = manager.flush.bind(manager);
    manager.flush = async () => {
      await flush();
      if (existsSync(path.join(process.env.IMAGE_CONTRACT_GATES!, "fail-flush"))) throw new Error("Controlled native HTTP image flush certification failure");
    };
  });
}
