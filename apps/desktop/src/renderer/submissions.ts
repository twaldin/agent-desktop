import type { CommandEnvelope, CommandResult, Draft } from "../../../../packages/shared/src/protocol";
import type { DraftCache } from "./drafts";

export interface PendingSubmission {
  draft: Draft;
  sessionId?: string;
  mode: "prompt" | "steer";
  create?: CommandEnvelope;
  send?: CommandEnvelope;
  uncertain: boolean;
}
/** Persist envelopes before delivery so an explicit retry uses the original command identity. */
export class SubmissionController {
  private pending: Record<string, PendingSubmission> = {};
  readonly cacheKey: string;
  cacheWarning: string | undefined;
  constructor(private command: (envelope: CommandEnvelope) => Promise<CommandResult>, hostId: string, private cache?: DraftCache) {
    this.cacheKey = `agent-desktop:submissions:v1:${hostId}`;
    try {
      const cached = JSON.parse(cache?.read(this.cacheKey) ?? "{}");
      for (const [id, value] of Object.entries(cached)) {
        const item = value as PendingSubmission;
        if (item?.draft?.id === id && typeof item.draft.text === "string" && ["prompt", "steer"].includes(item.mode) && (!item.create || item.create.command.type === "session.create") && (!item.send || ["session.prompt", "session.steer"].includes(item.send.command.type))) this.pending[id] = { ...item, uncertain: Boolean(item.create || item.send) };
      }
    } catch { this.cacheWarning = "Pending submission storage could not be read. Check conversation history before resending an earlier prompt."; }
  }
  get(id: string) { return this.pending[id]; }
  private save() { this.cache?.write(this.cacheKey, JSON.stringify(this.pending)); }
  private async deliver(item: PendingSubmission, phase: "create" | "send") {
    let result: CommandResult;
    try { result = await this.command(item[phase]!); }
    catch (cause) {
      item.uncertain = true; this.save();
      throw new Error(`Delivery is uncertain. Retry the pending submission to check the same command; it will not send a new copy. ${cause instanceof Error ? cause.message : String(cause)}`);
    }
    // These replies do not establish the outcome of this exact command. In
    // particular, HOST_STOPPING is returned before consulting the ledger, and
    // an ID conflict cannot certify that a previous attempt did not execute.
    // Keep the persisted envelope and snapshot until a definitive result or
    // explicit user reconciliation; an edited retry must never replace them.
    if (!result.ok && ["OUTCOME_UNKNOWN", "HOST_STOPPING", "COMMAND_ID_REUSED"].includes(result.error.code)) {
      item.uncertain = true; this.save();
      throw new Error(`Delivery is uncertain. Retry the pending submission to check the same command; it will not send a new copy. ${result.error.message}`);
    }
    item.uncertain = false;
    if (!result.ok) { item[phase] = undefined; this.save(); throw new Error(result.error.message); }
    return result.value;
  }
  async submit(snapshot: Draft, sessionId: string | undefined, mode: "prompt" | "steer") {
    let item = this.pending[snapshot.id];
    if (!item?.uncertain) {
      item = { draft: snapshot, sessionId: sessionId ?? item?.sessionId, mode, uncertain: false };
      this.pending[snapshot.id] = item;
    }
    if (!item.sessionId) {
      item.create ??= { id: crypto.randomUUID(), command: { type: "session.create", projectId: item.draft.projectId, model: item.draft.model ?? undefined } };
      this.save();
      const value = await this.deliver(item, "create");
      if (!value || !("sessionFile" in value)) { item.uncertain = true; this.save(); throw new Error("The host did not return the created session. Retry the pending submission to check the original command."); }
      item.sessionId = value.id; item.create = undefined; this.save();
    }
    const saved = item.draft;
    item.send ??= { id: crypto.randomUUID(), command: item.mode === "steer"
      ? { type: "session.steer", sessionId: item.sessionId, text: saved.text, draft: { id: saved.id, revision: saved.revision } }
      : { type: "session.prompt", sessionId: item.sessionId, text: saved.text, model: saved.model ?? undefined, thinkingLevel: saved.thinkingLevel || undefined, draft: { id: saved.id, revision: saved.revision } } };
    this.save();
    await this.deliver(item, "send");
    const result = { sessionId: item.sessionId, submitted: item.draft };
    delete this.pending[snapshot.id];
    try { this.save(); } catch { this.cacheWarning = "The message was accepted, but its local delivery receipt could not be cleared. A pending retry after restart checks the original command."; }
    return result;
  }
}
