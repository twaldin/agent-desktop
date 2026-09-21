import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent";
import type { NativeTurnReviewEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { TurnReview, TurnReviewFile } from "../../../../packages/shared/src/turn-review";
import { composeRecordedTextChanges, quoteRecordedPath, type RecordedTextFile } from "./recorded-diff";
import { TurnLedger, type CapturedFile, type CapturedSnapshot, type RecordedPatch, type TurnRecord } from "./ledger";
import { selectLastTurn } from "./selection";

function object(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function relativePath(cwd: string, path: string): string | undefined {
  const part = isAbsolute(path) ? relative(cwd, path) : path;
  return !part || part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part) ? undefined : part.split(sep).join("/");
}
const revision = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
/** Opt-in native operation observer. Filesystem observation happens here, never on a review read. */
export class TurnCapture {
  readonly ledger: TurnLedger;
  #tail: Promise<void> = Promise.resolve();
  #active: TurnRecord | undefined;
  #unjoinedServices = new Set<string>();
  #backgroundOwnerUncertain = false;
  #closed = false;
  constructor(readonly manager: SessionManager, readonly assertCurrent: () => void) {
    this.ledger = new TurnLedger(manager);
    const previous = this.ledger.records().at(-1);
    this.#unjoinedServices = new Set(previous?.unjoinedServices ?? []);
    this.#backgroundOwnerUncertain = previous?.backgroundOwnerUncertain === true || (previous?.backgroundJobs ?? 0) > 0;
  }
  observe = (event: NativeTurnReviewEvent): Promise<void> => {
    const next = this.#tail.then(async () => {
      this.assertCurrent();
      if (this.#closed) throw new Error("Recorded capture is closed.");
      if (event.sessionId !== this.manager.getSessionId() || event.cwd !== this.manager.getCwd()) throw new Error("The original native capture owner changed.");
      if (event.phase === "input") await this.input(event);
      else await this.settled(event);
      this.assertCurrent();
    });
    // Native callers await the original rejecting promise; reads also retain a failed barrier.
    this.#tail = next;
    return next;
  };
  private async input(event: Extract<NativeTurnReviewEvent, { phase: "input" }>): Promise<void> {
    const inputs = event.inputs.filter(input => input.userInitiated).map(input => input.entryId);
    // A reopened owner cannot establish continuity for an unfinished old capture.
    // Preserve its pending/partial record; never upgrade it from a later continuation.
    if (!inputs.length) return;
    const branch = new Set(this.manager.getBranch().map(entry => entry.id));
    if (inputs.some(id => !branch.has(id))) throw new Error("An effective native input is not on the original branch.");
    const record: TurnRecord = { version: 1, originSessionId: event.sessionId, turnId: inputs.at(-1)!, inputEntryIds: inputs, branchEntryIdAtInput: event.branchEntryId, cwd: event.cwd, before: null, after: null, recorded: null, derived: null, state: "pending", outcome: "running", reason: "Recording the foreground working-directory baseline.", producers: [], backgroundJobs: null, unjoinedServices: [...this.#unjoinedServices], backgroundOwnerUncertain: this.#backgroundOwnerUncertain };
    this.#active = record;
    await this.ledger.append(record);
    try {
      const before = await this.ledger.snapshot(event.cwd);
      record.before = await this.ledger.saveObject(before);
      record.reason = before.issues.length ? `Baseline capture is incomplete: ${before.issues.join(" ")}` : "The native operation is still running.";
      if (before.issues.length) record.state = "partial";
    } catch (error) { record.state = "unavailable"; record.reason = `Baseline capture failed: ${error instanceof Error ? error.message : String(error)}`; }
    await this.ledger.append({ ...record });
  }
  private async settled(event: Extract<NativeTurnReviewEvent, { phase: "settled" }>): Promise<void> {
    const record = this.#active;
    if (!record) return; // Legacy resumed work has no before-image; read remains explicitly unavailable.
    const branch = new Set(this.manager.getBranch().map(entry => entry.id));
    if (record.originSessionId !== event.sessionId || record.cwd !== event.cwd || record.inputEntryIds.some(id => !branch.has(id))) {
      this.#active = undefined;
      return; // Rewind/Fork may retire the original evidence, never append it onto another branch.
    }
    record.outcome = event.outcome;
    for (const tool of event.tools) {
      if (!record.producers.some(item => item.callId === tool.callId)) record.producers.push({ callId: tool.callId, name: tool.name, isError: tool.isError });
      const args = object(tool.args);
      if (tool.name === "hub" && args && typeof args.name === "string") {
        if (args.op === "start" || args.op === "restart") this.#unjoinedServices.add(args.name);
        if (args.op === "stop" && !tool.isError) this.#unjoinedServices.delete(args.name);
      }
    }
    record.backgroundJobs = event.backgroundJobs;
    record.unjoinedServices = [...this.#unjoinedServices];
    record.backgroundOwnerUncertain = this.#backgroundOwnerUncertain;
    let before: CapturedSnapshot | undefined;
    try {
      before = record.before ? await this.ledger.object<CapturedSnapshot>(record.before) : undefined;
      const after = await this.ledger.snapshot(event.cwd);
      record.after = await this.ledger.saveObject(after);
      const issues = [...(before?.issues ?? ["No complete recorded baseline is available."]), ...after.issues];
      if (before && !issues.length) record.recorded = await this.ledger.saveObject(await this.diff(before, after));
      const derived = await this.derived(event, before);
      if (derived.files.length) {
        const prior = record.derived ? await this.ledger.object<RecordedPatch>(record.derived) : { files: [], patch: "" };
        // Native fallback is recorded producer evidence, not a claim of a full net snapshot.
        record.derived = await this.ledger.saveObject({ files: [...prior.files, ...derived.files], patch: prior.patch + derived.patch });
      }
      const unjoined = (event.backgroundJobs ?? 0) > 0 || this.#unjoinedServices.size > 0;
      if (unjoined) issues.push("Native background work remains unjoined; this is only the foreground observation so far.");
      if (this.#backgroundOwnerUncertain) issues.push("A previous native owner left background work unjoined; this owner cannot establish its settlement.");
      if (issues.length) { record.state = record.recorded || record.derived ? "partial" : "unavailable"; record.reason = issues.join(" "); }
      else if (event.outcome === "running") { record.state = "pending"; record.reason = "The native operation is still running. Recorded foreground changes are shown so far."; }
      else { record.state = "available"; record.reason = event.outcome === "completed" ? null : `The ${event.outcome} operation's settled foreground filesystem changes were retained.`; }
    } catch (error) { record.state = record.recorded || record.derived ? "partial" : "unavailable"; record.reason = `Recorded capture could not finish: ${error instanceof Error ? error.message : String(error)}`; }
    await this.ledger.append({ ...record, producers: [...record.producers] });
  }
  private async text(file: CapturedFile): Promise<RecordedTextFile> { return { path: file.path, mode: file.mode, text: (await this.ledger.get(file.blob)).toString("utf8") }; }
  private async diff(before: CapturedSnapshot, after: CapturedSnapshot): Promise<RecordedPatch> {
    const old = new Map(before.files.map(file => [file.path, file])), next = new Map(after.files.map(file => [file.path, file]));
    const files: TurnReviewFile[] = [];
    const removed = before.files.filter(file => !next.has(file.path)), added = after.files.filter(file => !old.has(file.path));
    const renames = new Map<string, CapturedFile>();
    for (const missing of removed) {
      const moved = added.find(file => !renames.has(file.path) && file.blob === missing.blob && file.mode === missing.mode);
      if (moved) { renames.set(moved.path, missing); old.delete(missing.path); }
    }
    const paths = new Set([...old.keys(), ...next.keys()]);
    for (const path of paths) {
      const left = renames.get(path) ?? old.get(path), right = next.get(path);
      if (left && right && left.path === right.path && left.blob === right.blob && left.mode === right.mode) continue;
      if (left?.binary || right?.binary) {
        const oldName = quoteRecordedPath(`a/${left?.path ?? path}`), newName = quoteRecordedPath(`b/${right?.path ?? path}`);
        const patch = `diff --git ${oldName} ${newName}\n${!left ? `new file mode ${right!.mode}\n` : !right ? `deleted file mode ${left.mode}\n` : ""}Binary files ${left ? oldName : "/dev/null"} and ${right ? newName : "/dev/null"} differ\n`;
        files.push({ path: right?.path ?? left!.path, previousPath: left && right && left.path !== right.path ? left.path : null, kind: !left ? "A" : !right ? "D" : left.path !== right.path ? "R" : "M", binary: true, additions: null, deletions: null, patch });
      } else {
        const composed = composeRecordedTextChanges([{ before: left ? await this.text(left) : null, after: right ? await this.text(right) : null }]);
        files.push(...composed.files.map(file => ({ ...file, binary: false })));
      }
    }
    return { files, patch: files.map(file => file.patch).join("") };
  }
  private async derived(event: Extract<NativeTurnReviewEvent, { phase: "settled" }>, before: CapturedSnapshot | undefined): Promise<RecordedPatch> {
    const files: TurnReviewFile[] = [];
    for (const tool of event.tools) {
      if (tool.isError || tool.name !== "edit") continue;
      const details = object(object(tool.result)?.details);
      if (!details) continue;
      const entries = Array.isArray(details.files) ? details.files : [details];
      for (const raw of entries) {
        const entry = object(raw);
        if (!entry || entry.snapshotsPruned || typeof entry.path !== "string") continue;
        const path = relativePath(event.cwd, entry.path), previousPath = typeof entry.sourcePath === "string" ? relativePath(event.cwd, entry.sourcePath) : path;
        if (!path || !previousPath) continue;
        const deleted = entry.op === "delete", created = entry.op === "create" || entry.op === "add";
        if ((!created && typeof entry.oldText !== "string") || (!deleted && typeof entry.newText !== "string")) continue;
        const mode = before?.files.find(file => file.path === previousPath)?.mode ?? "100644";
        try {
          const composed = composeRecordedTextChanges([{ before: created ? null : { path: previousPath, text: entry.oldText as string, mode }, after: deleted ? null : { path, text: entry.newText as string, mode } }]);
          files.push(...composed.files.map(file => ({ ...file, binary: false })));
        } catch { /* A lossy native receipt is not suitable derived text evidence. */ }
      }
    }
    return { files, patch: files.map(file => file.patch).join("") };
  }
  async read(): Promise<TurnReview> {
    await this.#tail;
    this.assertCurrent();
    const sessionId = this.manager.getSessionId(), branch = this.manager.getBranch().map(entry => entry.id), cwd = this.manager.getCwd();
    const records = this.ledger.records();
    const groups = await Promise.all(records.map(async record => ({ record, recorded: record.recorded ? await this.ledger.object<RecordedPatch>(record.recorded) : null, derived: record.derived ? await this.ledger.object<RecordedPatch>(record.derived) : null })));
    this.assertCurrent();
    if (sessionId !== this.manager.getSessionId() || cwd !== this.manager.getCwd() || JSON.stringify(branch) !== JSON.stringify(this.manager.getBranch().map(entry => entry.id))) throw new Error("The original recorded review branch changed during the read. Refresh Last-turn.");
    const selected = selectLastTurn(groups.map(group => ({ turnId: group.record.turnId, recorded: group.recorded && (group.recorded.patch.length > 0 || group.recorded.files.some(file => file.binary)) ? group : null, derived: group.derived?.patch.length ? group : null })));
    const newest = groups.at(-1), chosen = selected?.value ?? newest;
    const identity = revision([sessionId, branch, records]);
    if (!chosen) return { sessionId, revision: identity, state: "unavailable", reason: "This conversation has no recorded turn baseline. Legacy edit receipts are not complete write or shell evidence.", selected: null, files: [], patch: "" };
    const source = selected?.source ?? "recorded", patch = source === "recorded" ? chosen.recorded : chosen.derived;
    let state = chosen.record.state, reason = chosen.record.reason;
    if (source === "derived") { state = "partial"; reason = "Only recorded successful edit evidence is available; write, shell or pruned evidence is incomplete."; }
    if (newest && newest !== chosen && newest.record.state !== "available") { state = newest.record.state === "unavailable" ? "partial" : newest.record.state; reason = `Showing the previous selected recorded changes. ${newest.record.reason ?? "The newest turn has incomplete capture."}`; }
    if (!patch && state === "available") { state = "unavailable"; reason = "The selected turn has no complete saved filesystem observation."; }
    return { sessionId, revision: identity, state, reason, selected: { turnId: chosen.record.turnId, originSessionId: chosen.record.originSessionId, inputEntryIds: chosen.record.inputEntryIds, cwd: chosen.record.cwd, source, outcome: chosen.record.outcome, coverage: "foreground-cwd" }, files: patch?.files ?? [], patch: patch?.patch ?? "" };
  }
  async close(): Promise<void> { await this.#tail; this.#closed = true; }
}
