import { resolve } from "node:path";
import { activateBundledRuntime } from "../runtime-ownership";

activateBundledRuntime(resolve(import.meta.dir, "../../../.."));
await import("./entry");
