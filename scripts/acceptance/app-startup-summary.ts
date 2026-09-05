import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function writeAppStartupSummary(output: string) {
  const result = JSON.parse(await readFile(join(output, "result.json"), "utf8"));
  const hash = async (path: string) => createHash("sha256").update(await readFile(join(output, path))).digest("hex");
  const artifacts = ["app-startup-main.mjs", "preload.cjs", "web/index.html", ...(await readdir(join(output, "web/assets"))).map(name => `web/assets/${name}`)];
  const states = result.state?.sessions ?? [];
  const summary = {
    passed: result.passed, error: result.error, scope: result.scope, electron: result.electron,
    paths: { rawResult: join(output, "result.json"), cleanup: join(output, "cleanup.json"), nativeHistory: (result.nativeHistory ?? []).map((item: any) => join(output, item.file)) },
    counts: { projects: result.state?.projects.length, sessions: states.length, drafts: result.state?.drafts.length, models: result.state?.models.length },
    assertions: { nativeStartupVisibleBeforeAdmission: Boolean(result.pending), keyboard: result.keyboard, explicitNativeAnswerAndDispatch: result.nativeHistory,
      newerDraftRetained: result.accepted ? { route: result.accepted.route, text: result.accepted.retainedDraft.text, permission: result.accepted.retainedDraft.approvalMode, revision: result.accepted.retainedDraft.revision, capturedSessionPermission: result.accepted.sessionApproval, nativePermission: result.accepted.nativeApproval } : undefined,
      selectionConflict: result.conflict ? { scope: result.conflict.scope, localPermission: result.conflict.localPermission, remotePermission: result.conflict.remotePermission } : undefined,
      olderHost: result.olderHost, layoutPassed: result.layoutPassed },
    nativeIds: { session: result.pending?.sessionId, interaction: result.pending?.nativeRequestId },
    commands: (result.calls ?? []).map((call: any) => {
      const command = call.args?.[0]?.command;
      return call.method === "command" ? { method: call.method, commandId: call.args[0].id, type: command.type, sessionId: command.sessionId ?? (command.type === "session.create" ? call.result?.value?.id : undefined), draftRevision: command.draft?.revision ?? command.expectedRevision, approvalMode: command.approvalMode ?? command.draft?.approvalMode, accepted: call.result?.ok, admission: call.result?.admission, error: call.error }
        : { method: call.method, sessionId: call.args[0], interactionId: call.args[1], response: call.args[2], accepted: call.result?.ok, error: call.error };
    }),
    captures: (result.captures ?? []).map((capture: any) => ({ file: capture.file, zoom: capture.zoom, viewport: capture.viewport, permission: capture.permission, fitting: capture.fitting, questionVisible: capture.questionVisible, horizontalOverflow: capture.horizontalOverflow, errors: capture.errors })),
    executedArtifactSha256: Object.fromEntries(await Promise.all(artifacts.map(async path => [path, await hash(path)]))),
    sourceAtBuild: result.sourceAtBuild,
    limitations: ["Hidden isolated profile, acceptance-only IPC adapter using production HTTP request/versioning helpers; not an installed desktop acceptance.", "Native startup and slash-command admission are real. The extension is controlled and providers are disabled; no native tool permission decision was tested.", "No and Cancel startup responses were not exercised.", ...(result.olderHost ? ["Unsupported permission capability is a controlled catalog projection, not an actual old host."] : [])],
  };
  await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2));
  return summary;
}
if (import.meta.main) await writeAppStartupSummary(resolve(process.argv[2]!));
