import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { launchSymbolNavigationApp } from "../symbol-navigation-launch";
import { exerciseFileEditorCommands, waitForOriginalFileEditors } from "./app";
import { interceptOwnedHost } from "./transport";
import type { prepareFileEditorGeometry } from "./geometry";

// Main compiles native.swift, grants the owned UI lease, and then runs this with
// FILE_EDITOR_GEOMETRY_PROBE pointing to that frozen native executable.
let transport: Awaited<ReturnType<typeof interceptOwnedHost>> | undefined;
let geometry: Awaited<ReturnType<typeof prepareFileEditorGeometry>> | undefined;
if (process.env.FILE_EDITOR_NATIVE_SENDER_LIFETIME || process.env.FILE_EDITOR_NATIVE_ROUTING_TRACE || process.env.FILE_EDITOR_ACCEPTANCE_SCOPE) {
  throw new Error("Diagnostic selectors are retired. This fixture always owns native senders through real ACKs and executes the complete ordered Editor sequence.");
}
await launchSymbolNavigationApp(resolve(process.argv[2] ?? `.data/file-editor-commands-${Date.now()}`), {
  additionalTabs: [{ path: "unsupported.py", destination: "right" }, { path: "symbol-target.ts", destination: "bottom" }],
  async hostReady({ fixture, output }) { transport = await interceptOwnedHost(fixture, output); return () => transport!.close(); },
  async prepare(_page, context) { geometry = context.geometry; },
  async exercise(page, output) {
    if (!transport || !geometry) throw new Error("The real host transport and owned geometry must be established before input.");
    // Exact original source/target readiness, one strict post-readiness geometry
    // sample and one guarded native admission capture all precede the single
    // tagged routing observer; the admitted owners bind every later assertion.
    const originals = await waitForOriginalFileEditors(page);
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(join(output, "00-original-editors.json"), JSON.stringify({ originals, wallTime: Date.now() }, null, 2));
    await geometry.check("file-editor-commands:original-editors-ready");
    await geometry.captureNative(resolve(output, "..", "00-native-admission.png"));
    return geometry.withNativeRoutingTrace(() => exerciseFileEditorCommands(page, output, geometry!, transport!, originals));
  },
});
