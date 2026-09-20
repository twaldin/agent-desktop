/** Real native extension fixture. Commands/events never call a model/provider. */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { writeFileSync } from "node:fs";
import path from "node:path";
export default function (pi: ExtensionAPI) {
  let original: ExtensionContext | undefined;
  pi.on("session_start", async (_event, ctx) => {
    original = ctx;
    const owner = path.basename(ctx.cwd);
    ctx.ui.setStatus("z", `${owner} ready`); ctx.ui.setStatus("__proto__", "\x1b[31mNative\x1b[0m\tstatus\nready");
    ctx.ui.setWidget("first", [`${owner} startup widget`, "\x1b[1;38;2;20;180;120mNative styled text\x1b[0m", "<script>window.extensionInjected=true</script>"]);
    ctx.ui.setWidget("second", ["Second widget"]);
    ctx.ui.setWidget("below", ["Native below composer"], { placement: "belowEditor" });
  });
  pi.events.on("extension-ui-fixture-update", () => { original?.ui.setStatus("z", `${path.basename(original.cwd)} event update`); original?.ui.setWidget("event", ["Native extension event"]); });
  pi.registerCommand("extension-ui-fixture", { description: "Disposable status and text-widget lifecycle", handler: async (args, ctx) => {
    if (args === "replace") { ctx.ui.setWidget("first", ["Replacement moved last"]); ctx.ui.setWidget("below", ["Moved above composer"]); ctx.ui.setStatus("z", "Command updated status"); }
    else if (args === "clear") { ctx.ui.setWidget("first", undefined); ctx.ui.setStatus("__proto__", undefined); }
    else if (args === "allclear") { for (const key of ["first", "second", "below", "event", "empty"]) ctx.ui.setWidget(key, undefined); for (const key of ["z", "__proto__"]) ctx.ui.setStatus(key, undefined); }
    else if (args === "event") pi.events.emit("extension-ui-fixture-update", {});
    else if (args === "empty") ctx.ui.setWidget("empty", []);
    else if (args === "long") ctx.ui.setWidget("first", Array.from({ length: 12 }, (_, index) => `Native line ${index + 1}`));
    else if (args === "factory") { try { ctx.ui.setWidget("factory", () => { throw new Error("Factory must never run"); }); } catch (error) { writeFileSync(path.join(ctx.cwd, "factory-result"), error instanceof Error ? error.message : String(error)); } }
  } });
  pi.on("session_shutdown", async (_event, ctx) => {
    try { ctx.ui.setStatus("late", "Should reject retired owner"); writeFileSync(path.join(ctx.cwd, "disposed-result"), "unexpected success"); }
    catch { writeFileSync(path.join(ctx.cwd, "disposed-result"), "late write rejected"); }
  });
}
