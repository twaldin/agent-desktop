import { resolve } from "node:path";
import { activateBundledRuntime } from "./runtime-ownership";

// Validate owned code before importing the server's SDK dependencies. Never auto-install or use a global OMP.
activateBundledRuntime(resolve(import.meta.dir, "../../.."));
const { runHostMain } = await import("./server");
await runHostMain();
