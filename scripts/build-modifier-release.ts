import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/** Compile, never execute, the helper for the same architecture as this desktop. */
export function buildModifierRelease(root: string, outputDirectory: string): void {
  if (process.platform !== "darwin") return;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x86_64" : undefined;
  if (!arch) throw new Error("Unsupported macOS desktop architecture.");
  mkdirSync(outputDirectory, { recursive: true });
  const result = spawnSync("/usr/bin/xcrun", ["swiftc", "-O", "-target", `${arch}-apple-macosx12.0`,
    join(root, "apps/desktop/native/modifier-release.swift"), "-o", join(outputDirectory, "modifier-release")], { stdio: "inherit" });
  if (result.error || result.status !== 0) throw result.error ?? new Error("Modifier release helper compilation failed.");
}
