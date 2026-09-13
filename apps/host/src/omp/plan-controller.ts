import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { CompactionCancelledError, type CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import type { AgentSession, AgentSessionEvent, ResolvedRoleModel, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { copyLocalArtifacts, resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import { listPlanFiles, readPlanFile } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-files";
import { humanizePlanTitle, normalizePlanTitle, planFileUrlForSlug, resolvePlanTitle, type PlanApprovalDetails } from "@oh-my-pi/pi-coding-agent/plan-mode/approved-plan";
import { normalizeLocalScheme, resolveToCwd } from "@oh-my-pi/pi-coding-agent/tools/path-utils";
import { combinePlanReviewFeedback, PlanReviewDocumentOwner,
  type PlanReviewAnnotationState, type PlanReviewDocumentAction, type PlanReviewDocumentSectionProjection,
  type PlanReviewDocumentSummary } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-review-document";
import { resolvePlanModelTransition } from "@oh-my-pi/pi-coding-agent/plan-mode/model-transition";
import { isMCPToolName } from "@oh-my-pi/pi-coding-agent/tools/builtin-names";
import { PROPOSE_DEVICE_NAME, writeDeviceDispatch } from "@oh-my-pi/pi-coding-agent/tools/resolve";
import { lookupBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { parseSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/parse";
import { prompt } from "@oh-my-pi/pi-utils";

const planModeApprovedPrompt = await Bun.file(new URL(import.meta.resolve(
  "@oh-my-pi/pi-coding-agent/prompts/system/plan-mode-approved",
))).text();
const planModeCompactInstructionsPrompt = await Bun.file(new URL(import.meta.resolve(
  "@oh-my-pi/pi-coding-agent/prompts/system/plan-mode-compact-instructions",
))).text();

type ModelState = { model: NonNullable<AgentSession["model"]>; thinking: ReturnType<AgentSession["configuredThinkingLevel"]> };
type Presentation = { enabled: string[]; mounted: string[] };
export interface NativePlanIdentity { nativeSessionId: string; sessionFile: string }
export interface NativePlanReviewSummary {
  id: string; revision: string; title: string; reference: string;
  documentRevision: string;
  status: "open" | "dismissed" | "awaiting-admission";
  canKeepContext: boolean; keepContextReason?: string;
}
export interface NativePlanReview extends NativePlanReviewSummary { content: string; document: PlanReviewDocumentSummary }
export interface NativePlanExecutionChoice {
  role: string; provider: string; modelId: string;
  thinking?: ReturnType<AgentSession["configuredThinkingLevel"]>;
  selected?: boolean; default?: boolean;
}
export interface NativePlanExecutionHandoff {
  phaseId: string; branch: "keep" | "compact" | "fresh" | "refine";
  reviewId: string; reviewRevision: string; reference: string; title: string;
  identity: NativePlanIdentity; prompt: string; compactOutcome?: CompactionOutcome; compactMessage?: string;
}
export interface NativePlanPreparedPhase {
  phaseId: string; branch: "keep" | "compact";
  reviewId: string; reviewRevision: string; reference: string; title: string;
  identity: NativePlanIdentity; compactOutcome?: CompactionOutcome; compactMessage?: string;
}
export interface NativePlanFreshReceipt {
  phaseId: string; branch: "fresh"; reviewId: string; reviewRevision: string;
  reference: string; title: string; oldIdentity: NativePlanIdentity; newIdentity: NativePlanIdentity;
}
export type NativePlanDecisionResult =
  | { kind: "execution"; phase: NativePlanPreparedPhase; snapshot: NativePlanSnapshot }
  | { kind: "fresh"; receipt: NativePlanFreshReceipt }
  | { kind: "cancelled"; branch: "compact" | "fresh"; compactOutcome?: "cancelled"; compactMessage?: string; snapshot?: NativePlanSnapshot };
export interface NativePlanSaveResult {
  savedDestination?: string; transition: "cancelled" | "new-session" | "unknown";
  oldIdentity: NativePlanIdentity; newIdentity?: NativePlanIdentity;
  message?: string; planExit?: "completed" | "unknown"; snapshot?: NativePlanSnapshot;
}
export interface NativePlanUnknownEffectReceipt {
  kind: "fresh" | "save"; transition: "unknown"; oldIdentity: NativePlanIdentity;
  newIdentity?: NativePlanIdentity; savedDestination?: string;
}
type NativePlanCompactionReceipt = { outcome: CompactionOutcome; message?: string };
export type NativePlanRefinement =
  | { kind: "admission"; phaseId: string; review: NativePlanReview }
  | { kind: "invite"; snapshot: NativePlanSnapshot };
type InternalReview = Omit<NativePlanReviewSummary, "documentRevision"> & {
  content: string; details: PlanApprovalDetails; documentOwner: PlanReviewDocumentOwner;
};
type PlanPhaseJournal = {
  version: 1; phaseId: string; branch: "keep" | "compact" | "fresh" | "refine";
  reviewId: string; reviewRevision: string; reference: string; title: string;
  nativeSessionId: string; sessionFile: string; state: "pending" | "dispatching" | "admitted";
  refinementText?: string; compactOutcome?: CompactionOutcome; compactMessage?: string;
};
const PLAN_PHASE_ENTRY = "agent-desktop-plan-execution";
export class NativePlanError extends Error {
  readonly receipt?: NativePlanUnknownEffectReceipt;
  readonly compaction?: NativePlanCompactionReceipt;
  readonly planExit?: "completed" | "unknown";
  constructor(readonly outcome: "rejected" | "unknown", message: string,
    options?: ErrorOptions & { receipt?: NativePlanUnknownEffectReceipt; compaction?: NativePlanCompactionReceipt;
      planExit?: "completed" | "unknown" }) {
    super(message, options); this.receipt = options?.receipt; this.compaction = options?.compaction; this.planExit = options?.planExit;
  }
}
export interface NativePlanInvocation {
  readonly name: "plan" | "plan-review";
  readonly prompt: string;
  /** Worker-local capability; never deserialize this from a client. */
  assertCurrent(): void;
}
/** Literal native extension/custom token precedence precedes builtin parsing. */
export function resolveNativePlanInvocation(session: AgentSession, text: string): NativePlanInvocation | undefined {
  const parsed = parseSlashCommand(text);
  const builtin = parsed && lookupBuiltinSlashCommand(parsed.name);
  if (!parsed || !builtin || builtin.name !== "plan" && builtin.name !== "plan-review") return;
  const space = text.indexOf(" "), token = space < 0 ? text.slice(1) : text.slice(1, space);
  const nativeId = session.sessionId, file = session.sessionFile;
  const owns = () => session.sessionId === nativeId && session.sessionFile === file
    && !session.extensionRunner?.getCommand(token) && !session.customCommands.some(item => item.command.name === token)
    && lookupBuiltinSlashCommand(parsed.name) === builtin;
  if (!owns()) return;
  return { name: builtin.name, prompt: parsed.args,
    assertCurrent() { if (!owns()) throw new NativePlanError("rejected", "The original native plan command no longer owns this input."); } };
}
export interface NativePlanSnapshot {
  nativeSessionId: string; sessionFile: string;
  mode: "active" | "paused" | "off";
  journalMode?: string; restorationRequired: boolean;
  planFilePath?: string; proposalHandlerOwned: boolean;
  model: { provider: string; id: string } | null;
  thinking: ReturnType<AgentSession["configuredThinkingLevel"]>;
  pendingModelChange: boolean; warning?: string;
  proposalError?: { outcome: "rejected" | "unknown"; message: string };
  restoration: "captured-before-entry" | "journal-model-preserved" | "not-owned";
  review?: NativePlanReviewSummary;
  executionChoices: NativePlanExecutionChoice[];
  defaultExecutionRole?: string;
  busy: boolean; canToggle: boolean; reconciliationRequired?: boolean;
}
export interface NativePlanTransition { snapshot: NativePlanSnapshot; prompt?: string; cancelled?: boolean }
export interface NativePlanPorts {
  /** Existing runtime admission/lifetime fence, required at every awaited boundary. */
  assertOwner(): void;
  /** Connect to the native interaction bridge. Only called when a real draft exists. */
  confirmExit(): Promise<boolean>;
  /** Runtime uses this as an invalidation hint; reads remain authoritative. */
  onChanged?(): void;
}

/** Desktop application owner over public native APIs. It does not approve a
 * plan, dispatch prompts, implement another queue, or change tool permissions.
 * Runtime must serialize this owner with other session mutations and call
 * settleModelTransition after native agent_end before admitting new work. */
export class NativePlanController {
  readonly #identity: { nativeSessionId: string; sessionFile: string };
  #previous?: { tools: Presentation; model?: ModelState; restored: boolean };
  #pendingModel?: ModelState;
  #entered = false;
  #busy = false;
  #disposed = false;
  #retiring = false;
  #warning?: string;
  #proposalError?: { outcome: "rejected" | "unknown"; message: string };
  #review?: InternalReview;
  #detachedDocument?: { reference: string; annotationState: PlanReviewAnnotationState };
  #proposalTask?: Promise<void>;
  #proposalFailure?: unknown;
  #activeOperation?: Promise<void>;
  #reconciliationRequired = false;
  readonly #proposal = (title: string) => this.prepareProposal(title);
  constructor(private readonly session: AgentSession, private readonly manager: SessionManager, private readonly ports: NativePlanPorts) {
    if (!session.sessionFile || session.sessionManager !== manager) throw new NativePlanError("rejected", "A persisted owning native session is required.");
    this.#identity = { nativeSessionId: session.sessionId, sessionFile: session.sessionFile };
    this.#assert();
  }
  #assert(invocation?: NativePlanInvocation) {
    this.ports.assertOwner();
    if (this.#disposed || this.session.sessionId !== this.#identity.nativeSessionId || this.session.sessionFile !== this.#identity.sessionFile
      || this.manager.getSessionId() !== this.#identity.nativeSessionId || this.manager.getSessionFile() !== this.#identity.sessionFile)
      throw new NativePlanError("rejected", "The original native planning owner has retired.");
    invocation?.assertCurrent();
  }
  snapshot(): NativePlanSnapshot {
    this.#assert();
    const state = this.session.getPlanModeState(), journal = this.manager.buildSessionContext();
    return { ...this.#identity, mode: state?.enabled ? "active" : journal.mode === "plan_paused" ? "paused" : "off",
      journalMode: journal.mode, restorationRequired: journal.mode === "plan" && !state?.enabled,
      planFilePath: state?.planFilePath, proposalHandlerOwned: this.session.peekPlanProposalHandler() === this.#proposal,
      model: this.session.model ? { provider: this.session.model.provider, id: this.session.model.id } : null,
      thinking: this.session.configuredThinkingLevel(), pendingModelChange: !!this.#pendingModel, warning: this.#warning,
      proposalError: this.#proposalError,
      restoration: this.#previous ? this.#previous.restored ? "journal-model-preserved" : "captured-before-entry" : "not-owned",
      review: this.#review ? this.#reviewSummary(this.#review) : undefined,
      executionChoices: this.#executionChoices(), defaultExecutionRole: this.#defaultExecutionRole(),
      busy: this.busy, reconciliationRequired: this.#reconciliationRequired,
      canToggle: !this.busy && !this.#reconciliationRequired && !this.session.isCompacting && !this.session.isAborting };
  }
  get busy(): boolean { return this.#busy || !!this.#proposalTask; }
  #localOptions() { return { getArtifactsDir: () => this.manager.getArtifactsDir(), getSessionId: () => this.manager.getSessionId() }; }
  #identityNow(): NativePlanIdentity {
    const sessionFile = this.session.sessionFile;
    if (!sessionFile) throw new NativePlanError("rejected", "A persisted native session is required.");
    return { nativeSessionId: this.session.sessionId, sessionFile };
  }
  #executionChoices(): NativePlanExecutionChoice[] {
    const cycle = this.session.getRoleModelCycle(this.session.settings.get("cycleOrder"));
    if (!cycle || cycle.models.length < 2) return [];
    return cycle.models.map(entry => ({ role: entry.role, provider: entry.model.provider, modelId: entry.model.id,
      ...(entry.thinkingLevel ? { thinking: entry.thinkingLevel } : {}), selected: cycle.models[cycle.currentIndex] === entry,
      default: entry.role === "default" }));
  }
  #defaultExecutionRole(): string | undefined {
    const cycle = this.session.getRoleModelCycle(this.session.settings.get("cycleOrder"));
    if (!cycle || cycle.models.length < 2) return;
    return cycle.models.find(entry => entry.role === "default")?.role ?? cycle.models[cycle.currentIndex]?.role;
  }
  #reviewSummary(review: InternalReview): NativePlanReviewSummary {
    const executionModel = this.#previous?.model?.model ?? this.session.model;
    const usage = this.session.getContextUsage(executionModel?.contextWindow ? { contextWindow: executionModel.contextWindow } : undefined);
    const canKeepContext = !usage || usage.percent <= 95;
    return { id: review.id, revision: review.revision, title: review.title, reference: review.reference,
      documentRevision: review.documentOwner.documentRevision,
      status: review.status, canKeepContext, ...(!canKeepContext ? { keepContextReason: `Context usage is ${usage.percent.toFixed(1)}%, above the native 95% limit.` } : {}) };
  }
  #reviewValue(review: InternalReview): NativePlanReview {
    const summary = this.#reviewSummary(review);
    return { ...summary, content: review.content,
      document: structuredClone(review.documentOwner.summary(review.documentOwner.documentRevision, 120)) };
  }
  #revision(reference: string, content: string): string {
    return createHash("sha256").update(reference).update("\0").update(content).digest("hex");
  }
  async #planPath(candidate: string, invocation?: NativePlanInvocation): Promise<{ reference: string; absolute: string }> {
    // Candidates come only from captured native state, proposal details, or the
    // newest native artifact scan. No caller supplies a read path. Preserve the
    // native reader's cwd-relative and legacy absolute journal behavior.
    if (!candidate.startsWith("local:")) {
      this.#assert(invocation);
      return { reference: candidate, absolute: resolveToCwd(candidate, this.manager.getCwd()) };
    }
    candidate = normalizeLocalScheme(candidate);
    const root = path.resolve(resolveLocalUrlToPath("local://", this.#localOptions()));
    const resolved = path.resolve(resolveLocalUrlToPath(candidate, this.#localOptions()));
    const inside = (base: string, target: string) => target !== base && !path.relative(base, target).startsWith("..") && !path.isAbsolute(path.relative(base, target));
    if (!inside(root, resolved)) throw new NativePlanError("rejected", "The plan reference leaves the session-local artifact root.");
    // Resolve the nearest existing ancestor, retaining the missing suffix.
    const canonical = async (file: string): Promise<string> => {
      try { const value = await realpath(file); this.#assert(invocation); return value; }
      catch (error) {
        this.#assert(invocation);
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = path.dirname(file); if (parent === file) throw error;
        return path.join(await canonical(parent), path.basename(file));
      }
    };
    const canonicalRoot = await canonical(root); this.#assert(invocation);
    const canonicalPath = await canonical(resolved); this.#assert(invocation);
    if (!inside(canonicalRoot, canonicalPath)) throw new NativePlanError("rejected", "The plan artifact resolves outside its native owner.");
    return { reference: candidate, absolute: resolved };
  }
  #assertHandler() {
    const handler = this.session.peekPlanProposalHandler();
    if (handler && handler !== this.#proposal) throw new NativePlanError("rejected", "Another native lifetime owns plan proposals.");
  }
  #tools(): Presentation { return { enabled: this.session.getEnabledToolNames().filter(name => !isMCPToolName(name)),
    mounted: this.session.getMountedXdevToolNames().filter(name => !isMCPToolName(name)) }; }
  #model(): ModelState | undefined { return this.session.model ? { model: this.session.model, thinking: this.session.configuredThinkingLevel() } : undefined; }
  async #setModel(state: ModelState, invocation?: NativePlanInvocation) {
    this.#assert(invocation);
    if (modelsAreEqual(this.session.model, state.model)) this.session.setThinkingLevel(state.thinking);
    else await this.session.setModelTemporary(state.model, state.thinking);
    this.#assert(invocation);
  }
  async #operation<T>(invocation: NativePlanInvocation | undefined, work: (changed: () => void) => Promise<T>): Promise<T> {
    this.#assert(invocation);
    if (this.#reconciliationRequired) throw new NativePlanError("unknown", "Native Plan state requires owner reconciliation.");
    if (this.#busy || this.session.isCompacting || this.session.isAborting) throw new NativePlanError("rejected", "Native planning maintenance is still settling.");
    this.#busy = true; let changed = false;
    const settled = Promise.withResolvers<void>(); this.#activeOperation = settled.promise;
    try { const value = await work(() => { changed = true; }); this.#assert(invocation); return value; }
    catch (cause) {
      const outcome = changed || cause instanceof NativePlanError && cause.outcome === "unknown" ? "unknown" : "rejected";
      if (outcome === "unknown") this.#reconciliationRequired = true;
      throw new NativePlanError(outcome, cause instanceof Error ? cause.message : String(cause),
        { cause, ...(cause instanceof NativePlanError && cause.receipt ? { receipt: cause.receipt } : {}) });
    }
    finally { this.#busy = false; settled.resolve(); if (this.#activeOperation === settled.promise) this.#activeOperation = undefined; }
  }
  async #enter(restored: boolean, planPath: string, changed: () => void, invocation?: NativePlanInvocation): Promise<void> {
    this.#assert(invocation); this.#assertHandler();
    if (!this.session.settings.get("plan.enabled")) throw new NativePlanError("rejected", "Plan mode is disabled in native settings.");
    const mode = this.manager.buildSessionContext().mode;
    if (mode === "goal" || mode === "goal_paused" || this.session.getGoalModeState()?.enabled || this.session.getGoalModeState()?.goal.status === "paused")
      throw new NativePlanError("rejected", "Exit goal mode before planning.");
    if (mode === "vibe" || this.session.getVibeModeState()?.enabled) throw new NativePlanError("rejected", "Exit vibe mode before planning.");
    if (this.session.getPlanModeState()?.enabled) {
      if (!this.#previous) throw new NativePlanError("rejected", "Restore this native plan through its owning controller first.");
      return;
    }
    const file = (await this.#planPath(planPath, invocation)).reference; this.#assert(invocation); this.#assertHandler();
    const previous = { tools: this.#tools(), model: this.#model(), restored };
    const originalState = this.session.getPlanModeState();
    changed();
    this.session.setPlanModeState({ enabled: true, planFilePath: file, workflow: "parallel", reentry: this.#entered });
    try {
      const tools = this.session.getEnabledToolNames();
      await this.session.setActiveToolsByName(this.session.hasBuiltInTool("write") ? [...new Set([...tools, "write"])] : tools);
      this.#assert(invocation); this.#assertHandler();
    } catch (cause) {
      this.#assert(invocation); this.#assertHandler(); this.session.setPlanModeState(originalState);
      await this.session.restoreNonMCPToolPresentation(previous.tools.enabled, previous.tools.mounted); this.#assert(invocation);
      throw cause;
    }
    this.#previous = previous;
    this.session.setPlanProposalHandler(this.#proposal);
    if (!restored) {
      const resolved = this.session.resolveRoleModelWithThinking("plan");
      const configured = this.session.settings.getModelRole("plan")?.trim();
      this.#warning = resolved.warning ?? (!resolved.model && configured && configured !== "default"
        ? "The configured native plan role has no available model; keeping the current session model." : undefined);
      // Native entry captures a model to restore only when the plan role
      // actually resolves. Without it, later explicit model edits remain owned
      // by the user and must not be undone when leaving planning.
      if (!resolved.model) previous.model = undefined;
      const transition = resolvePlanModelTransition(this.session.model, resolved, this.session.isStreaming);
      if (transition.kind === "thinking") this.session.setThinkingLevel(transition.thinkingLevel);
      if (transition.kind === "apply") {
        const desired = { model: transition.model, thinking: transition.thinkingLevel };
        if (transition.deferred) this.#pendingModel = desired;
        else {
          try { await this.#setModel(desired, invocation); }
          catch (cause) { this.#assert(invocation); this.#warning = `Native plan model could not be selected: ${cause instanceof Error ? cause.message : cause}`; }
        }
      }
    }
    this.#assert(invocation);
    if (this.session.isStreaming) { await this.session.sendPlanModeContext({ deliverAs: "steer" }); this.#assert(invocation); }
    this.#entered = true;
    this.manager.appendModeChange("plan", { planFilePath: file });
    await this.manager.flush(); this.#assert(invocation);
  }
  enter(invocation?: NativePlanInvocation): Promise<NativePlanTransition> {
    if (invocation?.name === "plan-review") throw new NativePlanError("rejected", "Plan review does not enter plan mode.");
    return this.#operation(invocation, async changed => {
      await this.#enter(false, this.session.getPlanReferencePath() || "local://PLAN.md", changed, invocation);
      return { snapshot: this.snapshot(), ...(invocation?.prompt ? { prompt: invocation.prompt } : {}) };
    });
  }
  /** Explicit startup reconciliation. Reads never call this. The SDK-restored
   * journal model is retained; historical pre-plan model is not reconstructed. */
  restore(): Promise<NativePlanTransition> {
    return this.#operation(undefined, async changed => {
      const context = this.manager.buildSessionContext();
      if (!this.session.settings.get("plan.enabled") && ["plan", "plan_paused"].includes(context.mode ?? "")) {
        if (this.session.getPlanModeState()?.enabled) throw new NativePlanError("rejected", "Exit the live native plan before clearing its journal mode.");
        changed(); this.manager.appendModeChange("none"); await this.manager.flush(); this.#assert();
      } else if (context.mode === "plan") {
        const file = context.modeData?.planFilePath;
        if (file !== undefined && typeof file !== "string") throw new NativePlanError("rejected", "The journal plan path is invalid.");
        await this.#enter(true, file || "local://PLAN.md", changed);
      } else if (context.mode === "plan_paused") this.#entered = true;
      return { snapshot: this.snapshot() };
    });
  }
  pause(invocation?: NativePlanInvocation): Promise<NativePlanTransition> {
    return this.#operation(invocation, async changed => {
      const state = this.session.getPlanModeState();
      if (!state?.enabled || !this.#previous) throw new NativePlanError("rejected", "This owner has no active native plan to pause.");
      this.#assertHandler();
      const paths = new Set([state.planFilePath, ...await listPlanFiles({ localProtocolOptions: this.#localOptions() })]); this.#assert(invocation);
      for (const file of paths) {
        const owned = await this.#planPath(file, invocation); this.#assert(invocation);
        const content = await readPlanFile(owned.reference, { localProtocolOptions: this.#localOptions(), cwd: this.manager.getCwd() }); this.#assert(invocation);
        if (content?.trim()) {
          const confirmed = await this.ports.confirmExit(); this.#assert(invocation);
          if (!confirmed) return { snapshot: this.snapshot(), cancelled: true };
          break;
        }
      }
      this.#assertHandler();
      const previous = this.#previous, activeTools = this.#tools(), activeModel = this.#model();
      const teardown = async () => {
        this.#assert(invocation); this.#assertHandler(); changed();
        if (this.session.isStreaming) { await this.session.abort(); this.#assert(invocation); }
        this.session.setPlanModeState(undefined);
        try {
          await this.session.restoreNonMCPToolPresentation(previous.tools.enabled, previous.tools.mounted); this.#assert(invocation);
          if (previous.model && !previous.restored) await this.#setModel(previous.model, invocation);
        } catch (cause) {
          this.#assert(invocation); this.#assertHandler(); this.session.setPlanModeState(state);
          await this.session.restoreNonMCPToolPresentation(activeTools.enabled, activeTools.mounted); this.#assert(invocation);
          if (activeModel) await this.#setModel(activeModel, invocation);
          throw cause;
        }
        this.#assert(invocation); this.#assertHandler();
        if (this.session.peekPlanProposalHandler() === this.#proposal) this.session.setPlanProposalHandler(null);
        this.#previous = undefined; this.#pendingModel = undefined;
        this.manager.appendModeChange("plan_paused"); await this.manager.flush(); this.#assert(invocation);
      };
      await this.session.runModeExitTeardown(teardown); this.#assert(invocation);
      return { snapshot: this.snapshot() };
    });
  }
  /** Native no-prompt third toggle. Active exit requires pause/confirmation. */
  disable(invocation?: NativePlanInvocation): Promise<NativePlanTransition> {
    return this.#operation(invocation, async changed => {
      if (this.snapshot().mode !== "paused") throw new NativePlanError("rejected", "Only paused native planning can be turned off without an exit confirmation.");
      changed(); this.manager.appendModeChange("none"); await this.manager.flush(); this.#assert(invocation);
      this.#entered = false; return { snapshot: this.snapshot() };
    });
  }
  toggle(invocation: NativePlanInvocation): Promise<NativePlanTransition> {
    this.#assert(invocation);
    if (invocation.name !== "plan") throw new NativePlanError("rejected", "Use the plan-review operation for this native command.");
    const mode = this.snapshot().mode;
    return mode === "active" ? this.pause(invocation) : mode === "paused" && !invocation.prompt ? this.disable(invocation) : this.enter(invocation);
  }
  settleModelTransition(): Promise<NativePlanTransition> {
    return this.#operation(undefined, async changed => {
      if (this.#pendingModel && this.session.getPlanModeState()?.enabled && !this.session.isStreaming) {
        const pending = this.#pendingModel; changed();
        await this.#setModel(pending); this.#assert(); this.#pendingModel = undefined;
        await this.manager.flush(); this.#assert();
      }
      return { snapshot: this.snapshot() };
    });
  }
  /** Prompt completion joins detached proposal work before applying a deferred
   * Plan-role model. A fresh-session phase retires this owner and is never
   * allowed to mutate the replacement identity. */
  async settleAfterTurn(): Promise<NativePlanTransition | undefined> {
    while (this.#proposalTask || this.#activeOperation) {
      const pending = [this.#proposalTask, this.#activeOperation].filter((value): value is Promise<void> => value !== undefined);
      if (!pending.length) break;
      await Promise.allSettled(pending);
    }
    if (this.#proposalFailure) throw this.#proposalFailure;
    if (this.#disposed || this.session.sessionId !== this.#identity.nativeSessionId || this.session.sessionFile !== this.#identity.sessionFile
      || this.manager.getSessionId() !== this.#identity.nativeSessionId || this.manager.getSessionFile() !== this.#identity.sessionFile) return;
    return this.settleModelTransition();
  }
  async prepareProposal(title: string): ReturnType<AgentSession["preparePlanForReview"]> {
    this.#assert();
    const state = this.session.getPlanModeState();
    const assertPlan = () => {
      this.#assert();
      if (!state?.enabled || this.session.getPlanModeState() !== state || this.session.peekPlanProposalHandler() !== this.#proposal)
      throw new NativePlanError("rejected", "This owner has no active native plan proposal handler.");
    };
    assertPlan();
    // Validate all native candidate references before the native resolver reads
    // them. The resolver itself retains title/fallback selection authority.
    const candidates = new Set([state!.planFilePath,
      ...await listPlanFiles({ localProtocolOptions: this.#localOptions() })]); assertPlan();
    try {
      const normalized = normalizePlanTitle(title).title;
      candidates.add(planFileUrlForSlug(normalized.replace(/-plan$/i, "") || normalized));
    } catch { /* Native resolver falls back for an absent/invalid title. */ }
    for (const candidate of candidates) { await this.#planPath(candidate); assertPlan(); }
    const result = await this.session.preparePlanForReview(title); assertPlan();
    if (!result.details) throw new NativePlanError("rejected", "Native plan preparation returned no review details.");
    await this.#planPath(result.details.planFilePath); assertPlan();
    return result;
  }
  async prepareLatestReview(invocation?: NativePlanInvocation): Promise<PlanApprovalDetails> {
    this.#assert(invocation);
    if (invocation && invocation.name !== "plan-review") throw new NativePlanError("rejected", "This command does not own plan review.");
    const state = this.session.getPlanModeState();
    const assertPlan = () => {
      this.#assert(invocation);
      if (!state?.enabled || this.session.getPlanModeState() !== state || this.session.peekPlanProposalHandler() !== this.#proposal)
        throw new NativePlanError("rejected", "This owner has no active native plan to review.");
    };
    assertPlan();
    const [file] = await listPlanFiles({ localProtocolOptions: this.#localOptions() }); assertPlan();
    if (!file) throw new NativePlanError("rejected", "No native plan file is available to review.");
    await this.#planPath(file, invocation); assertPlan();
    const content = await readPlanFile(file, { localProtocolOptions: this.#localOptions(), cwd: this.manager.getCwd() }); assertPlan();
    if (content === null) throw new NativePlanError("rejected", "The native plan file is no longer available.");
    // Native /plan-review selects the newest artifact directly. Running it
    // through title-based proposal resolution could select an older same-title file.
    return { planFilePath: file, title: resolvePlanTitle({ planContent: content, planFilePath: file }).title, planExists: true };
  }

  /** Observe the native proposal device without holding the session event chain. */
  observeEvent(event: AgentSessionEvent): void {
    if (this.#retiring || this.#disposed) return;
    if (event.type !== "tool_execution_end" || event.isError) return;
    const dispatch = writeDeviceDispatch(event.toolName, event.result);
    const details = dispatch?.tool === PROPOSE_DEVICE_NAME && dispatch.mode === "execute" ? dispatch.inner : undefined;
    if (!details || typeof details !== "object" || !("planFilePath" in details) || !("title" in details)
      || !("planExists" in details) || typeof details.planFilePath !== "string" || typeof details.title !== "string"
      || typeof details.planExists !== "boolean") return;
    const approval: PlanApprovalDetails = { planFilePath: details.planFilePath, title: details.title, planExists: details.planExists };
    const prior = this.#proposalTask ?? Promise.resolve();
    const task = prior.catch(() => {}).then(async () => {
      try { await this.#openReview(approval); }
      catch (error) {
        this.#warning = error instanceof Error ? error.message : String(error);
        this.#proposalError = { outcome: error instanceof NativePlanError ? error.outcome : "unknown", message: this.#warning };
        if (this.#proposalError.outcome === "unknown") this.#reconciliationRequired = true;
        this.#proposalFailure = error;
        this.ports.onChanged?.();
      }
    });
    this.#proposalTask = task;
    void task.then(() => { if (this.#proposalTask === task) this.#proposalTask = undefined; });
  }

  async #openReview(details: PlanApprovalDetails, invocation?: NativePlanInvocation): Promise<NativePlanReview> {
    return this.#operation(invocation, async changed => {
      const state = this.session.getPlanModeState();
      if (!state?.enabled || this.session.peekPlanProposalHandler() !== this.#proposal)
        throw new NativePlanError("rejected", "This owner has no active native plan to review.");
      const owned = await this.#planPath(details.planFilePath, invocation); this.#assert(invocation);
      changed();
      this.session.markPlanInternalAbortPending();
      try { await this.session.abort(); }
      finally { this.session.clearPlanInternalAbortPending(); }
      this.#assert(invocation);
      const content = await readPlanFile(owned.reference, { localProtocolOptions: this.#localOptions(), cwd: this.manager.getCwd() });
      this.#assert(invocation);
      if (!content) throw new NativePlanError("unknown", `Plan file not found at ${owned.reference}`);
      if (state.planFilePath !== owned.reference) {
        this.session.setPlanModeState({ ...state, planFilePath: owned.reference });
        this.manager.appendModeChange("plan", { planFilePath: owned.reference });
        await this.manager.flush(); this.#assert(invocation);
      }
      const id = randomUUID(), revision = this.#revision(owned.reference, content);
      const annotationState = this.#detachedDocument?.reference === owned.reference
        ? structuredClone(this.#detachedDocument.annotationState) : undefined;
      const review: InternalReview = { id, revision,
        title: details.title || resolvePlanTitle({ planContent: content, planFilePath: owned.reference }).title,
        reference: owned.reference, content, status: "open", canKeepContext: true, details: { ...details, planFilePath: owned.reference },
        documentOwner: new PlanReviewDocumentOwner(content, {
          binding: JSON.stringify([id, owned.reference, revision]), ...(annotationState ? { annotationState } : {}),
        }) };
      if (annotationState) this.#detachedDocument = undefined;
      this.#review = { ...review, ...this.#reviewSummary(review) };
      this.#proposalError = undefined;
      this.ports.onChanged?.();
      return this.#reviewValue(this.#review);
    });
  }

  readReview(): NativePlanReview | undefined {
    this.#assert();
    return this.#review ? this.#reviewValue(this.#review) : undefined;
  }

  async openLatestReview(invocation?: NativePlanInvocation): Promise<NativePlanReview> {
    const details = await this.prepareLatestReview(invocation);
    return this.#openReview(details, invocation);
  }

  #ownedReview(input: { reviewId: string; reviewRevision: string; documentRevision?: string }, options?: { allowDismissed?: boolean }): InternalReview {
    this.#assert();
    if (this.#reconciliationRequired) throw new NativePlanError("unknown", "Native Plan state requires owner reconciliation.");
    const review = this.#review;
    if (!review || review.id !== input.reviewId || review.revision !== input.reviewRevision)
      throw new NativePlanError("rejected", "The native plan review changed; reopen it before continuing.");
    if (input.documentRevision !== undefined && review.documentOwner.documentRevision !== input.documentRevision)
      throw new NativePlanError("rejected", "The native Plan review document changed; refresh before continuing.");
    if (!options?.allowDismissed && review.status === "dismissed")
      throw new NativePlanError("rejected", "The native plan review is dismissed; reopen it before continuing.");
    return review;
  }

  async #assertReviewArtifact(review: InternalReview): Promise<void> {
    const content = await readPlanFile(review.reference, { localProtocolOptions: this.#localOptions(), cwd: this.manager.getCwd() });
    this.#assert();
    if (content === null) throw new NativePlanError("rejected", "The reviewed native Plan artifact is unavailable.");
    if (this.#revision(review.reference, content) !== review.revision)
      throw new NativePlanError("rejected", "The reviewed native Plan artifact changed; reopen it before continuing.");
  }

  readReviewDocumentSection(input: { reviewId: string; reviewRevision: string; documentRevision: string;
    renderColumns: number; sectionId: string }): PlanReviewDocumentSectionProjection {
    const review = this.#ownedReview(input, { allowDismissed: true });
    return review.documentOwner.section(input.documentRevision, input.sectionId, input.renderColumns);
  }

  async mutateReviewDocument(input: { reviewId: string; reviewRevision: string; action: PlanReviewDocumentAction;
    renderColumns: number }): Promise<{ review: NativePlanReview; artifactChanged: boolean }> {
    return this.#operation(undefined, async changed => {
      const review = this.#ownedReview({ ...input, documentRevision: input.action.expectedDocumentRevision });
      const prepared = review.documentOwner.prepare(input.action, input.renderColumns);
      await this.#assertReviewArtifact(review);
      this.#ownedReview({ ...input, documentRevision: input.action.expectedDocumentRevision });
      if (prepared.result.artifactChanged) {
        const owned = await this.#planPath(review.reference); this.#assert();
        this.#ownedReview({ ...input, documentRevision: input.action.expectedDocumentRevision }); changed();
        await mkdir(path.dirname(owned.absolute), { recursive: true });
        await writeFile(owned.absolute, prepared.result.content); this.#assert();
        this.#ownedReview({ ...input, documentRevision: input.action.expectedDocumentRevision });
      } else changed();
      const updated: InternalReview = { ...review, content: prepared.result.content,
        revision: this.#revision(review.reference, prepared.result.content), status: "open", documentOwner: prepared.next };
      this.#review = { ...updated, ...this.#reviewSummary(updated) };
      this.ports.onChanged?.();
      return { review: this.#reviewValue(this.#review), artifactChanged: prepared.result.artifactChanged };
    });
  }

  async editReview(input: { reviewId: string; reviewRevision: string; documentRevision: string; content: string }): Promise<NativePlanReview> {
    return this.#operation(undefined, async changed => {
      const review = this.#ownedReview(input);
      const prepared = review.documentOwner.prepareReplace({ content: input.content,
        expectedDocumentRevision: input.documentRevision, renderColumns: 120 });
      await this.#assertReviewArtifact(review); this.#ownedReview(input);
      const owned = await this.#planPath(review.reference); this.#assert();
      this.#ownedReview(input); changed();
      await mkdir(path.dirname(owned.absolute), { recursive: true });
      await writeFile(owned.absolute, prepared.result.content); this.#assert();
      const current = this.#ownedReview(input);
      const updated: InternalReview = { ...current, content: prepared.result.content,
        revision: this.#revision(current.reference, prepared.result.content), status: "open", documentOwner: prepared.next };
      this.#review = { ...updated, ...this.#reviewSummary(updated) };
      this.ports.onChanged?.();
      return this.#reviewValue(this.#review);
    });
  }

  dismissReview(input: { reviewId: string; reviewRevision: string }): NativePlanSnapshot {
    const review = this.#ownedReview(input);
    this.#review = { ...review, status: "dismissed" };
    this.ports.onChanged?.();
    return this.snapshot();
  }

  reopenReview(input: { reviewId: string; reviewRevision: string }): NativePlanReview {
    const review = this.#ownedReview(input, { allowDismissed: true });
    this.#review = { ...review, status: "open" };
    this.ports.onChanged?.();
    return this.#reviewValue(this.#review);
  }

  prepareRefinement(input: { reviewId: string; reviewRevision: string; documentRevision: string; text: string }): Promise<NativePlanRefinement> {
    return this.#operation(undefined, async changed => {
      const review = this.#ownedReview(input);
      const refinementText = combinePlanReviewFeedback(review.documentOwner.feedback, input.text);
      if (!refinementText.trim()) {
        this.#detachedDocument = { reference: review.reference,
          annotationState: structuredClone(review.documentOwner.annotationState) };
        this.#review = undefined; this.ports.onChanged?.();
        return { kind: "invite", snapshot: this.snapshot() };
      }
      await this.#assertReviewArtifact(review); this.#ownedReview(input);
      const phaseId = randomUUID();
      changed();
      this.#appendPhase({ phaseId, branch: "refine", reviewId: review.id, reviewRevision: review.revision,
        reference: review.reference, title: review.title, refinementText });
      await this.manager.flush(); this.#assert();
      this.#review = { ...review, status: "awaiting-admission" };
      this.ports.onChanged?.();
      return { kind: "admission", phaseId, review: this.#reviewValue(this.#review) };
    });
  }

  #executionRole(role: string | undefined): ResolvedRoleModel | undefined {
    if (!role) return;
    const cycle = this.session.getRoleModelCycle(this.session.settings.get("cycleOrder"));
    if (!cycle || cycle.models.length < 2) throw new NativePlanError("rejected", "The native execution model has no selectable alternatives.");
    const entry = cycle.models.find(candidate => candidate.role === role);
    if (!entry) throw new NativePlanError("rejected", "The selected native execution role is no longer available.");
    return entry;
  }

  async #applyExecutionModel(entry: ResolvedRoleModel | undefined, outcome?: CompactionOutcome): Promise<void> {
    const previous = this.#previous?.model;
    if (outcome === "failed") return;
    if (entry) await this.session.applyRoleModel(entry);
    else if (previous) await this.#setModel(previous);
    this.#previous = this.#previous ? { ...this.#previous, model: undefined } : undefined;
  }

  async #exitForApproval(deferModelRestore: boolean, changed: () => void): Promise<Presentation> {
    const state = this.session.getPlanModeState(), previous = this.#previous;
    if (!state?.enabled || !previous || this.session.peekPlanProposalHandler() !== this.#proposal)
      throw new NativePlanError("rejected", "This owner has no active native plan approval.");
    const activeTools = this.#tools(), activeModel = this.#model();
    changed(); this.session.setPlanModeState(undefined);
    try {
      await this.session.restoreNonMCPToolPresentation(previous.tools.enabled, previous.tools.mounted); this.#assert();
      if (!deferModelRestore && previous.model) await this.#setModel(previous.model);
    } catch (error) {
      this.#assert(); this.session.setPlanModeState(state);
      await this.session.restoreNonMCPToolPresentation(activeTools.enabled, activeTools.mounted);
      if (activeModel) await this.#setModel(activeModel);
      throw error;
    }
    if (this.session.peekPlanProposalHandler() === this.#proposal) this.session.setPlanProposalHandler(null);
    this.#pendingModel = undefined;
    if (!deferModelRestore) this.#previous = undefined;
    this.manager.appendModeChange("none"); await this.manager.flush(); this.#assert();
    return previous.tools;
  }

  async #executionTools(presentation: Presentation): Promise<void> {
    const enabled = presentation.enabled.includes("read") ? presentation.enabled : [...presentation.enabled, "read"];
    await this.session.restoreNonMCPToolPresentation(enabled, presentation.mounted);
  }

  async #seedTitle(title: string): Promise<void> {
    const name = humanizePlanTitle(title);
    if (name && !this.manager.getSessionName()) await this.manager.setSessionName(name, "auto");
  }

  #appendPhase(input: Omit<PlanPhaseJournal, "version" | "nativeSessionId" | "sessionFile" | "state">): PlanPhaseJournal {
    const identity = this.#identityNow();
    const data: PlanPhaseJournal = { version: 1, ...input, ...identity, state: "pending" };
    this.manager.appendCustomEntry(PLAN_PHASE_ENTRY, data);
    return data;
  }

  #phase(phaseId: string): PlanPhaseJournal | undefined {
    for (const entry of [...this.manager.getEntries()].reverse()) {
      if (entry.type !== "custom" || entry.customType !== PLAN_PHASE_ENTRY || !entry.data || typeof entry.data !== "object") continue;
      const data = entry.data as Partial<PlanPhaseJournal>;
      if (data.version === 1 && data.phaseId === phaseId && (data.state === "pending" || data.state === "dispatching" || data.state === "admitted")
        && (data.branch === "keep" || data.branch === "compact" || data.branch === "fresh" || data.branch === "refine")
        && typeof data.reviewId === "string" && typeof data.reviewRevision === "string" && typeof data.reference === "string"
        && typeof data.title === "string" && typeof data.nativeSessionId === "string" && typeof data.sessionFile === "string"
        && (data.branch !== "refine" || typeof data.refinementText === "string")
        && (data.compactOutcome === undefined || data.compactOutcome === "ok" || data.compactOutcome === "cancelled" || data.compactOutcome === "failed")
        && (data.compactMessage === undefined || typeof data.compactMessage === "string" && data.compactOutcome !== undefined)
        && (data.branch === "compact" || data.compactOutcome === undefined && data.compactMessage === undefined))
        return data as PlanPhaseJournal;
    }
  }

  async decide(input: { reviewId: string; reviewRevision: string; documentRevision: string;
    action: "keep" | "compact" | "fresh"; executionRole?: string }): Promise<NativePlanDecisionResult> {
    const review = this.#ownedReview(input);
    if (input.action === "keep" && !this.#reviewSummary(review).canKeepContext)
      throw new NativePlanError("rejected", "Native context usage is above the 95% keep-context limit.");
    const role = this.#executionRole(input.executionRole);
    if (input.action === "fresh") return this.#approveFresh(review, role);
    const branch: "keep" | "compact" = input.action;
    let observedCompaction: NativePlanCompactionReceipt | undefined, planCompleted = false;
    try { return await this.#operation(undefined, async changed => {
      this.#ownedReview(input);
      await this.#assertReviewArtifact(review); this.#ownedReview(input);
      const compact = branch === "compact";
      if (compact) this.session.markPlanInternalAbortPending();
      let outcome: CompactionOutcome | undefined, compactMessage: string | undefined;
      const presentation = await this.#exitForApproval(compact, changed);
      try {
        if (compact) {
          this.session.setPlanReferencePath(review.reference);
          try {
            await this.session.compact(undefined, { internalGuidance: prompt.render(planModeCompactInstructionsPrompt,
              { planFilePath: review.reference }) });
            outcome = "ok";
          } catch (error) {
            outcome = error instanceof CompactionCancelledError ? "cancelled" : "failed";
            compactMessage = error instanceof Error ? error.message : String(error);
          }
          observedCompaction = { outcome, ...(compactMessage ? { message: compactMessage } : {}) };
        }
      } finally { if (compact) this.session.clearPlanInternalAbortPending(); }
      await this.#executionTools(presentation); this.#assert();
      await this.#applyExecutionModel(role, outcome); this.#assert();
      this.session.setPlanReferencePath(review.reference);
      this.#review = undefined; this.#detachedDocument = undefined;
      planCompleted = true;
      if (outcome === "cancelled") { this.ports.onChanged?.(); return { kind: "cancelled", branch: "compact", compactOutcome: "cancelled",
        ...(compactMessage ? { compactMessage } : {}), snapshot: this.snapshot() }; }
      await this.#seedTitle(review.title); this.#assert();
      const phaseId = randomUUID();
      const phase = this.#appendPhase({ phaseId, branch, reviewId: review.id, reviewRevision: review.revision,
        reference: review.reference, title: review.title,
        ...(outcome ? { compactOutcome: outcome } : {}), ...(compactMessage ? { compactMessage } : {}) });
      await this.manager.flush(); this.#assert();
      const phaseResult: NativePlanPreparedPhase = { phaseId, branch, reviewId: review.id,
        reviewRevision: review.revision, reference: review.reference, title: review.title,
        identity: { nativeSessionId: phase.nativeSessionId, sessionFile: phase.sessionFile },
        ...(outcome ? { compactOutcome: outcome } : {}), ...(compactMessage ? { compactMessage } : {}) };
      this.ports.onChanged?.();
      return { kind: "execution", phase: phaseResult, snapshot: this.snapshot() };
    }); } catch (cause) {
      if (!(cause instanceof NativePlanError) || cause.outcome !== "unknown") throw cause;
      throw new NativePlanError("unknown", cause.message, { cause,
        ...(observedCompaction ? { compaction: observedCompaction } : {}), planExit: planCompleted ? "completed" : "unknown" });
    }
  }

  async #approveFresh(review: InternalReview, role: ResolvedRoleModel | undefined): Promise<NativePlanDecisionResult> {
    this.#assert();
    if (this.#busy || this.session.isCompacting || this.session.isAborting) throw new NativePlanError("rejected", "Native planning maintenance is still settling.");
    this.#busy = true; let changed = false;
    const settled = Promise.withResolvers<void>(); this.#activeOperation = settled.promise;
    const oldIdentity = { ...this.#identity }, oldRoot = resolveLocalUrlToPath("local://", this.#localOptions());
    let replacementIdentity: NativePlanIdentity | undefined;
    try {
      await this.#assertReviewArtifact(review);
      const presentation = await this.#exitForApproval(false, () => { changed = true; });
      const created = await this.session.newSession();
      if (!created) { this.#assert(); this.#review = undefined; this.#detachedDocument = undefined; this.ports.onChanged?.();
        return { kind: "cancelled", branch: "fresh", snapshot: this.snapshot() }; }
      const newIdentity = this.#identityNow();
      replacementIdentity = newIdentity;
      this.manager.appendModeChange("none");
      const newRoot = resolveLocalUrlToPath("local://", this.#localOptions());
      await copyLocalArtifacts(oldRoot, newRoot);
      if (review.reference.startsWith("local:")) {
        const target = resolveLocalUrlToPath(normalizeLocalScheme(review.reference), this.#localOptions());
        await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, review.content);
      }
      await this.#executionTools(presentation);
      if (role) await this.session.applyRoleModel(role);
      this.session.setPlanReferencePath(review.reference);
      await this.#seedTitle(review.title);
      const phaseId = randomUUID();
      this.#appendPhase({ phaseId, branch: "fresh", reviewId: review.id, reviewRevision: review.revision,
        reference: review.reference, title: review.title });
      await this.manager.flush();
      this.#review = undefined; this.#detachedDocument = undefined; this.ports.onChanged?.();
      return { kind: "fresh", receipt: { phaseId, branch: "fresh", reviewId: review.id,
        reviewRevision: review.revision, reference: review.reference, title: review.title, oldIdentity, newIdentity } };
    } catch (cause) {
      if (changed) this.#reconciliationRequired = true;
      const observedReplacement = replacementIdentity ?? (this.session.sessionFile
        && (this.session.sessionId !== oldIdentity.nativeSessionId || this.session.sessionFile !== oldIdentity.sessionFile)
        ? { nativeSessionId: this.session.sessionId, sessionFile: this.session.sessionFile } : undefined);
      throw new NativePlanError(changed ? "unknown" : "rejected", cause instanceof Error ? cause.message : String(cause), {
        cause, ...(observedReplacement ? { receipt: { kind: "fresh", transition: "unknown", oldIdentity,
          newIdentity: observedReplacement } satisfies NativePlanUnknownEffectReceipt } : {}),
      });
    } finally { this.#busy = false; settled.resolve(); if (this.#activeOperation === settled.promise) this.#activeOperation = undefined; }
  }

  #pendingPhase(phaseId: string): PlanPhaseJournal {
    const phase = this.#phase(phaseId), identity = this.#identityNow();
    if (!phase) throw new NativePlanError("rejected", "The native Plan execution phase is unavailable.");
    if (phase.nativeSessionId !== identity.nativeSessionId || phase.sessionFile !== identity.sessionFile)
      throw new NativePlanError("rejected", "The native Plan execution phase belongs to another session identity.");
    if (phase.state === "dispatching")
      throw new NativePlanError("unknown", "Native Plan prompt admission was interrupted after its durable dispatch claim.");
    if (phase.state === "admitted") throw new NativePlanError("rejected", "The native Plan execution phase was already admitted.");
    return phase;
  }

  async #executionHandoff(phase: PlanPhaseJournal): Promise<NativePlanExecutionHandoff> {
    const content = await readPlanFile(phase.reference, { localProtocolOptions: this.#localOptions(), cwd: this.manager.getCwd() }); this.#assert();
    if (!content) throw new NativePlanError("rejected", "The approved native Plan artifact is unavailable.");
    if (this.#revision(phase.reference, content) !== phase.reviewRevision)
      throw new NativePlanError("rejected", "The approved native Plan artifact changed after review.");
    return { phaseId: phase.phaseId, branch: phase.branch, reviewId: phase.reviewId, reviewRevision: phase.reviewRevision,
      reference: phase.reference, title: phase.title, identity: this.#identityNow(),
      ...(phase.compactOutcome ? { compactOutcome: phase.compactOutcome } : {}),
      ...(phase.compactMessage ? { compactMessage: phase.compactMessage } : {}),
      prompt: phase.branch === "refine" ? phase.refinementText! : prompt.render(planModeApprovedPrompt,
        { planFilePath: phase.reference, planContent: content, contextPreserved: phase.branch !== "fresh" }) };
  }

  prepareExecution(input: { phaseId: string }): Promise<NativePlanExecutionHandoff> {
    return this.#operation(undefined, async () => this.#executionHandoff(this.#pendingPhase(input.phaseId)));
  }

  claimExecution(input: { phaseId: string }): Promise<NativePlanExecutionHandoff> {
    return this.#operation(undefined, async changed => {
      const phase = this.#pendingPhase(input.phaseId);
      const handoff = await this.#executionHandoff(phase); this.#assert();
      changed(); this.manager.appendCustomEntry(PLAN_PHASE_ENTRY, { ...phase, state: "dispatching" } satisfies PlanPhaseJournal);
      await this.manager.flush(); this.#assert();
      return handoff;
    });
  }

  async settleExecutionAdmission(input: { phaseId: string; outcome: "entered" | "not-entered" | "unknown" }): Promise<NativePlanSnapshot> {
    // A refinement can produce its next native proposal while the exact input
    // entry is still flushing. Join work that was already admitted by the
    // native event listener, then validate the original durable phase claim.
    // This method has not entered #operation yet, so it never waits on itself.
    while (this.#proposalTask || this.#activeOperation) {
      const pending = [this.#proposalTask, this.#activeOperation].filter((value): value is Promise<void> => value !== undefined);
      if (!pending.length) break;
      await Promise.allSettled(pending);
    }
    if (this.#proposalFailure) throw this.#proposalFailure;
    return this.#operation(undefined, async changed => {
      const phase = this.#phase(input.phaseId), identity = this.#identityNow();
      if (!phase || phase.state !== "dispatching" || phase.nativeSessionId !== identity.nativeSessionId || phase.sessionFile !== identity.sessionFile)
        throw new NativePlanError("rejected", "The native Plan execution phase has no durable dispatch claim.");
      if (input.outcome === "unknown") {
        this.#reconciliationRequired = true; this.ports.onChanged?.(); return this.snapshot();
      }
      changed();
      if (input.outcome === "entered") {
        if (phase.branch !== "refine") this.session.markPlanReferenceSent();
        if (phase.branch === "refine" && this.#review?.id === phase.reviewId && this.#review.revision === phase.reviewRevision) {
          this.#review = undefined; this.#detachedDocument = undefined;
        }
        this.manager.appendCustomEntry(PLAN_PHASE_ENTRY, { ...phase, state: "admitted" } satisfies PlanPhaseJournal);
      } else {
        if (phase.branch === "refine" && this.#review?.id === phase.reviewId && this.#review.revision === phase.reviewRevision)
          this.#review = { ...this.#review, status: "open" };
        this.manager.appendCustomEntry(PLAN_PHASE_ENTRY, { ...phase, state: "pending" } satisfies PlanPhaseJournal);
      }
      await this.manager.flush(); this.#assert(); this.ports.onChanged?.();
      return this.snapshot();
    });
  }

  async saveAndStartNew(input: { reviewId: string; reviewRevision: string; documentRevision: string;
    destination: string }): Promise<NativePlanSaveResult> {
    const review = this.#ownedReview(input), oldIdentity = { ...this.#identity };
    const destination = resolveToCwd(input.destination, this.manager.getCwd());
    if (this.#busy || this.session.isCompacting || this.session.isAborting)
      throw new NativePlanError("rejected", "Native planning maintenance is still settling.");
    this.#busy = true; let effectStarted = false, planCompleted = false;
    const settled = Promise.withResolvers<void>(); this.#activeOperation = settled.promise;
    try {
      this.#ownedReview(input);
      await this.#assertReviewArtifact(review); this.#ownedReview(input);
      effectStarted = true;
      await writeFile(destination, review.content); this.#assert();
      await this.#exitForApproval(false, () => {}); this.#review = undefined; this.#detachedDocument = undefined; planCompleted = true;
      const created = await this.session.newSession();
      if (!created) return { savedDestination: destination, transition: "cancelled", oldIdentity,
        planExit: "completed", snapshot: this.snapshot() };
      this.manager.appendModeChange("none"); await this.manager.flush();
      return { savedDestination: destination, transition: "new-session", oldIdentity, newIdentity: this.#identityNow() };
    } catch (cause) {
      if (!effectStarted) throw new NativePlanError("rejected", cause instanceof Error ? cause.message : String(cause), { cause });
      this.#reconciliationRequired = true;
      return { savedDestination: destination, transition: "unknown", oldIdentity,
        ...(this.session.sessionFile ? { newIdentity: this.#identityNow() } : {}),
        planExit: planCompleted ? "completed" : "unknown",
        message: cause instanceof Error ? cause.message : String(cause) };
    } finally { this.#busy = false; settled.resolve(); if (this.#activeOperation === settled.promise) this.#activeOperation = undefined; }
  }
  /** Stop accepting proposal events, join controller work, then retire this
   * lifetime. Cleanup callers receive any proposal failure instead of losing it. */
  async dispose(): Promise<void> {
    this.#retiring = true;
    while (this.#proposalTask || this.#activeOperation) {
      const pending = [this.#proposalTask, this.#activeOperation].filter((value): value is Promise<void> => value !== undefined);
      if (!pending.length) break;
      await Promise.allSettled(pending);
    }
    if (this.session.sessionId === this.#identity.nativeSessionId && this.session.sessionFile === this.#identity.sessionFile
      && this.session.peekPlanProposalHandler() === this.#proposal) this.session.setPlanProposalHandler(null);
    this.#disposed = true; this.#pendingModel = undefined;
    if (this.#proposalFailure) {
      const cause = this.#proposalFailure; this.#proposalFailure = undefined;
      throw cause;
    }
  }
}
