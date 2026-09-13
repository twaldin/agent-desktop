import { parseForceToolCancel, parseForceToolCancelResult, parseForceToolGuard, parseForceToolReceipt, parseForceToolRecovery,
  type CommandEnvelope, type CommandResult, type Draft, type ForceToolGuard, type ForceToolReceipt } from "../../../../packages/shared/src/protocol";
import type { ComposerActionsCatalog } from "../../../../packages/shared/src/composer-actions";
import { captureDraft, sameDraftContent, type DraftCache } from "./drafts";
import { ForceToolOperationRefused, type ForceToolRecoveryRequest } from "./force-tool-state";

export interface NativeForceSubmission { nativeForce: true; guard?: ForceToolGuard }
/** This detects syntax for catalog lookup, never authorizes native dispatch. */
export const forceCommandSpelling = (text: string) => /^\s*\/force(?=\s|:|$)/.test(text);
export function nativeForceWinner(catalog: ComposerActionsCatalog | null, text: string): boolean {
  if (!forceCommandSpelling(text)) return false;
  if (!text.startsWith("/")) throw new Error("Native slash commands must begin at the start of the draft.");
  const space = text.indexOf(" "), exactName = space < 0 ? text.slice(1) : text.slice(1, space);
  // Native checks exact extension/custom names before resolving builtin aliases.
  const exact = catalog?.commands.find(command => command.name === exactName && command.availability !== "shadowed"
    && ["extension", "custom", "mcp-prompt"].includes(command.source.kind));
  if (exact) return false;
  const winner = catalog?.commands.find(command => command.name === "force" && command.source.kind === "builtin");
  if (!winner) throw new Error("The owning host did not resolve this command. The draft was retained.");
  // A canonical /force collision does not shadow /force:<tool> in native parsing.
  if (!["executable", "partial"].includes(winner.availability)
    && !(winner.availability === "shadowed" && exactName.startsWith("force:")))
    throw new Error(winner.reason ?? "Update the owning host to use native /force. The draft was retained.");
  return true;
}
export function remainingForcePrompt(text: string, receipt: ForceToolReceipt): string {
  if (!/^\/force(?:[\s:]|$)/.test(text)) throw new Error("The original native force prompt could not be matched to its receipt.");
  // Pinned native parseSlashCommand trims args after its first separator, then
  // the original /force handler splits tool from prompt on the first space.
  const args = text.slice(7).trim(), space = args.indexOf(" ");
  const toolName = space < 0 ? args : args.slice(0, space);
  if (toolName !== receipt.toolName) throw new Error("The original native force prompt could not be matched to its receipt.");
  return space < 0 ? "" : args.slice(space + 1).trim();
}
type Prepared = { sessionId: string; draft: Draft; guard: ForceToolGuard };
type Operation = { envelope: CommandEnvelope; result?: CommandResult; settled?: boolean };
/** Desktop-only identities. Native queue contents are never persisted or replayed here. */
export class ForceToolSubmissions {
  private prepared: Record<string, Prepared> = {};
  private operations: Record<string, Operation> = {};
  private flights = new Map<string, Promise<CommandResult>>();
  readonly cacheKey: string;
  cacheWarning?: string;
  constructor(private command: (request: CommandEnvelope) => Promise<CommandResult>, readonly hostId: string, private cache?: DraftCache) {
    this.cacheKey = `agent-desktop:force-operations:v1:${hostId}`;
    try {
      const saved = JSON.parse(cache?.read(this.cacheKey) ?? '{"prepared":{},"operations":{}}');
      for (const [id, value] of Object.entries(saved.prepared)) {
        const item = value as Prepared;
        if (item.draft.id !== id || !item.sessionId) throw new Error("Invalid prepared owner");
        this.prepared[id] = { sessionId: item.sessionId, draft: captureDraft(item.draft, hostId), guard: parseForceToolGuard(item.guard) };
      }
      for (const [key, value] of Object.entries(saved.operations)) {
        const operation = value as Operation, envelope = operation.envelope, command = envelope.command;
        if (envelope.commandVersion !== 18 || !/^[a-zA-Z0-9_-]{1,200}$/.test(envelope.id)) throw new Error("Invalid force operation identity");
        if (command.type === "session.force.cancel") {
          const { type, ...request } = command; parseForceToolCancel(request);
        } else if (command.type === "session.prompt" && command.forceRecovery && !command.forceTool) {
          parseForceToolRecovery(command.forceRecovery);
          if (!command.sessionId || typeof command.text !== "string" || !command.text.trim()) throw new Error("Invalid recovery prompt");
        } else throw new Error("Invalid force operation");
        if (key !== this.operationKey(command)) throw new Error("Force operation key changed");
        // Recheck the exact persisted command with the host after restart. A local
        // cached result must never authorize a new native operation.
        this.operations[key] = { envelope: structuredClone(envelope), ...(operation.settled === true ? { settled: true } : {}) };
      }
    } catch { this.cacheWarning = "Force operation storage could not be read. Inspect the owning conversation before sending another request."; }
  }
  private save() { this.cache?.write(this.cacheKey, JSON.stringify({ prepared: this.prepared, operations: this.operations })); }
  prepare(sessionId: string, draft: Draft, guard: ForceToolGuard) {
    this.prepared[draft.id] = { sessionId, draft: captureDraft(draft, this.hostId), guard: parseForceToolGuard(guard) }; this.save();
  }
  selection(sessionId: string | undefined, draft: Draft, nativeWinner: boolean): NativeForceSubmission | undefined {
    if (this.cacheWarning) throw new Error(this.cacheWarning);
    const prepared = this.prepared[draft.id];
    if (prepared && forceCommandSpelling(draft.text)) {
      if (!nativeWinner) throw new Error("A custom command now owns /force. Rebuild the prepared draft before sending.");
      if (sessionId !== prepared.sessionId || !sameDraftContent(draft, prepared.draft))
        throw new Error("The prepared force draft or model changed. Review the tool and insert the draft again.");
      return { nativeForce: true, guard: structuredClone(prepared.guard) };
    }
    return nativeWinner ? { nativeForce: true } : undefined;
  }
  private operationKey(command: CommandEnvelope["command"]) {
    if (command.type === "session.force.cancel") return JSON.stringify([command.type, command.sessionId, command.ticket.epoch, command.directiveId]);
    if (command.type === "session.prompt" && command.forceRecovery) return JSON.stringify(["force-recovery", command.sessionId, command.forceRecovery.epoch, command.forceRecovery.directiveId]);
    throw new Error("Unsupported force operation");
  }
  private run(command: CommandEnvelope["command"]): Promise<CommandResult> {
    if (this.cacheWarning) return Promise.reject(new Error(this.cacheWarning));
    const key = this.operationKey(command), existing = this.flights.get(key);
    if (existing) return existing;
    let operation: Operation | undefined = this.operations[key];
    if (operation?.result && !operation.result.ok && JSON.stringify(operation.envelope.command) !== JSON.stringify(command)) operation = undefined;
    if (!operation) { operation = { envelope: { id: crypto.randomUUID(), commandVersion: 18, command: structuredClone(command) } }; this.operations[key] = operation; }
    // Save must succeed even on retry: a previous storage failure cannot turn
    // an unpersisted ID into a live operation.
    this.save();
    if (operation.result) return Promise.resolve(structuredClone(operation.result));
    const captured = operation;
    const flight = (async () => {
      const result = await this.command(structuredClone(captured.envelope));
      if (result.commandId !== captured.envelope.id) throw new Error("The owning host returned another force operation identity.");
      if (!result.ok && ["OUTCOME_UNKNOWN", "HOST_STOPPING", "COMMAND_ID_REUSED"].includes(result.error.code)) throw new Error(result.error.message);
      captured.result = structuredClone(result); this.save(); return result;
    })().finally(() => this.flights.delete(key));
    this.flights.set(key, flight); return flight;
  }
  pendingOperations(sessionId: string) {
    return Object.values(this.operations).filter(item => !item.settled && "sessionId" in item.envelope.command && item.envelope.command.sessionId === sessionId)
      .map(item => ({ id: item.envelope.id, kind: item.envelope.command.type === "session.force.cancel" ? "cancel" as const : "recover" as const }));
  }
  private settle(command: CommandEnvelope["command"]) {
    this.operations[this.operationKey(command)]!.settled = true; this.save();
  }
  async check(sessionId: string, id: string) {
    const operation = Object.values(this.operations).find(item => item.envelope.id === id), command = operation?.envelope.command;
    if (!command || !("sessionId" in command) || command.sessionId !== sessionId) throw new Error("The pending force operation belongs to another owner.");
    const result = await this.run(command);
    if (!result.ok) { this.settle(command); throw new ForceToolOperationRefused(result.error.message); }
    if (command.type === "session.force.cancel") {
      if (!result.value || !("type" in result.value) || result.value.type !== "session.force.cancel") throw new Error("Missing native cancellation receipt.");
      const { type, ...value } = result.value, receipt = parseForceToolCancelResult(value);
      if (receipt.cancelledDirectiveId !== command.directiveId) throw new Error("Cancellation receipt names a different directive.");
      this.settle(command); return { epoch: command.ticket.epoch, directiveId: command.directiveId };
    }
    if (command.type !== "session.prompt" || !command.forceRecovery || result.admission?.kind !== "user-message" || !result.admission.entryId)
      throw new Error("The host did not confirm the recovered user prompt.");
    this.settle(command); return { epoch: command.forceRecovery.epoch, directiveId: command.forceRecovery.directiveId };
  }
  async cancel(sessionId: string, input: { epoch: string; expectedRevision: number; directiveId: string }) {
    const request = parseForceToolCancel({ sessionId, ticket: { epoch: input.epoch, revision: input.expectedRevision }, directiveId: input.directiveId });
    const result = await this.run({ type: "session.force.cancel", ...request });
    if (!result.ok) { this.settle({ type: "session.force.cancel", ...request }); throw new ForceToolOperationRefused(result.error.message); }
    if (!result.value || !("type" in result.value) || result.value.type !== "session.force.cancel") throw new Error("Missing native cancellation receipt. Check the original operation.");
    const { type, ...value } = result.value;
    const receipt = parseForceToolCancelResult(value);
    if (receipt.cancelledDirectiveId !== request.directiveId) throw new Error("The host cancelled a different force directive.");
    this.settle({ type: "session.force.cancel", ...request });
    return receipt.state;
  }
  async recover(sessionId: string, request: ForceToolRecoveryRequest, original: Draft) {
    const receipt = parseForceToolReceipt(request.originalReceipt);
    if (receipt.arm !== "armed" || receipt.prompt !== "not-recorded" || receipt.directiveId !== request.directiveId
      || receipt.epoch !== request.ticket.epoch || remainingForcePrompt(original.text, receipt) !== request.text)
      throw new Error("The original force receipt does not permit this prompt recovery.");
    if (original.attachments?.length || original.selectedTextAttachments?.length || original.wholeFileAttachments?.length)
      throw new Error("An attachment-bearing force record cannot authorize prompt recovery.");
    const forceRecovery = parseForceToolRecovery({ epoch: request.ticket.epoch, expectedRevision: request.ticket.revision, directiveId: request.directiveId });
    const command: CommandEnvelope["command"] = { type: "session.prompt", sessionId, text: request.text, forceRecovery,
      ...(original.model ? { model: original.model } : {}), ...(original.thinkingLevel ? { thinkingLevel: original.thinkingLevel } : {}),
      ...(original.approvalMode ? { approvalMode: original.approvalMode } : {}) };
    const result = await this.run(command);
    if (!result.ok) { this.settle(command); throw new ForceToolOperationRefused(result.error.message); }
    if (result.admission?.kind !== "user-message" || !result.admission.entryId) throw new Error("The host did not confirm the recovered user prompt. Check the original operation.");
    this.settle(command);
  }
}
