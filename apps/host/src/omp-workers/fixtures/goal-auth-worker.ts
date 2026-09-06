// Test-only worker entry that holds credential revalidation before native
// continuation admission. It never reads credential contents or contacts a provider.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";

const gates = process.env.GOAL_AUTH_GATES;
if (!gates) throw new Error("Controlled goal auth worker requires isolated file gates");
mkdirSync(gates, { recursive: true });
const original = AuthStorage.prototype.revalidateCredentials;
AuthStorage.prototype.revalidateCredentials = async function (...args) {
  const holding = existsSync(path.join(gates, "hold-auth"));
  if (holding) {
    writeFileSync(path.join(gates, "auth.started"), "");
    while (!existsSync(path.join(gates, "auth.release"))) await Bun.sleep(5);
  }
  return original.apply(this, args);
};

await import("../entry");
