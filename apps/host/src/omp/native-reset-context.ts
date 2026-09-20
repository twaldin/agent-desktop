import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  AgentSession, CodexResetPolicySessionBinding, NativeResetAnswer, ResetPass, ResetPlanSnapshot,
} from "@oh-my-pi/pi-coding-agent";
import type {
  ResetAccountEvidence, ResetCreditAccountStatus, ResetCreditConsumeIdentity,
  SessionCredentialSelectionObservation,
} from "@oh-my-pi/pi-ai/auth-storage";
import { sameResetAccountEvidence } from "@oh-my-pi/pi-ai/auth/reset-account-evidence";
import { normalizeCodexBaseUrl } from "@oh-my-pi/pi-ai/usage/openai-codex-base-url";
import { pickSoonestExpiringCredit } from "@oh-my-pi/pi-ai/usage/openai-codex-reset";
import type { ResetPolicySettingsObservation, SettingPath } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { NativeResetPassContext } from "../omp-workers/reset-policy-native-owner";
import type { ResetPolicyWireAccount, ResetPolicyWireCredit } from "../omp-workers/reset-policy-wire";
import type { OmpInteractionBridge } from "./interactions";

const RESET_PATHS = ["codexResets.autoRedeem", "codexResets.minBlockedMinutes", "codexResets.keepCredits", "codexResets.salvageHorizonHours"] as const satisfies readonly SettingPath[];
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const clone = <T>(value: T): T => structuredClone(value);

export interface NativeResetPassContextFactoryOptions {
  binding: Readonly<CodexResetPolicySessionBinding>;
  interactions: Pick<OmpInteractionBridge, "runWithDecisionBinding">;
}

type CapturedAccount = Readonly<{ evidence: ResetAccountEvidence; projected: ResetPolicyWireAccount }>;
type PersistedSnapshot = Awaited<ReturnType<ReturnType<CodexResetPolicySessionBinding["settings"]["capturePersistedReadback"]>["read"]>>;

function policy(binding: Readonly<CodexResetPolicySessionBinding>) {
  return clone(binding.settings.getGroup("codexResets"));
}

function projectAccount(evidence: ResetAccountEvidence, baseUrl: string | undefined): ResetPolicyWireAccount {
  if (evidence.provider !== "openai-codex" || !Number.isSafeInteger(evidence.credentialId)) throw new Error("Reset account evidence is unsupported");
  return Object.freeze({ provider: "openai-codex", ...(baseUrl ? { baseUrl } : {}), credentialId: evidence.credentialId,
    ...(evidence.accountId ? { accountId: evidence.accountId } : {}), ...(evidence.email ? { email: evidence.email } : {}),
    ...(evidence.orgId ? { orgId: evidence.orgId } : {}), ...(evidence.projectId ? { projectId: evidence.projectId } : {}),
    credentialFingerprint: evidence.credentialFingerprint, authAuthority: evidence.authAuthority });
}

function sameHigherLayers(before: PersistedSnapshot, after: PersistedSnapshot): boolean {
  return before.cwd === after.cwd && before.agentDir === after.agentDir
    && isDeepStrictEqual(before.project, after.project) && isDeepStrictEqual(before.overlay, after.overlay)
    && isDeepStrictEqual(before.runtime, after.runtime)
    && before.resetPolicyWriter.available && after.resetPolicyWriter.available
    && before.resetPolicyWriter.targetId === after.resetPolicyWriter.targetId;
}

/** Captures child-local native objects synchronously. The returned context owns
 * only its Settings observation and session subscription. */
export function createNativeResetPassContextFactory(options: NativeResetPassContextFactoryOptions): (pass: ResetPass) => NativeResetPassContext {
  const { binding, interactions } = options;
  return pass => new BoundNativeResetPassContext(binding, interactions, pass);
}

class BoundNativeResetPassContext implements NativeResetPassContext {
  readonly source;
  readonly #binding: Readonly<CodexResetPolicySessionBinding>;
  readonly #interactions: Pick<OmpInteractionBridge, "runWithDecisionBinding">;
  readonly #pass: ResetPass;
  readonly #model: NonNullable<AgentSession["model"]>;
  readonly #modelDigest: string;
  readonly #baseUrl?: string;
  readonly #registryBaseUrl?: string;
  readonly #selection: SessionCredentialSelectionObservation;
  readonly #accounts = new Map<number, CapturedAccount>();
  readonly #settingsObservation: ResetPolicySettingsObservation;
  readonly #readback;
  readonly #initialPolicy;
  readonly #unsubscribe: () => void;
  #modelChanged = false;
  #disposed = false;
  #policyRevision = randomUUID();
  #planned?: Readonly<{ snapshot: ResetPlanSnapshot; accounts: readonly CapturedAccount[]; persisted: PersistedSnapshot }>;
  #decision: Readonly<{ recorded: true; answer: NativeResetAnswer }> | undefined;
  #persistenceDone = false;

  constructor(binding: Readonly<CodexResetPolicySessionBinding>, interactions: Pick<OmpInteractionBridge, "runWithDecisionBinding">, pass: ResetPass) {
    this.#binding = binding; this.#interactions = interactions; this.#pass = clone(pass);
    if (binding.session.sessionId !== pass.nativeSessionId || binding.session.settings !== binding.settings
      || binding.session.modelRegistry !== binding.modelRegistry || binding.modelRegistry.authStorage !== binding.authStorage)
      throw new Error("Reset pass is not bound to its original native session");
    const model = binding.session.model;
    if (!model || model.id !== pass.modelId || model.provider !== pass.provider) throw new Error("Reset pass model changed before capture");
    this.#model = model; this.#modelDigest = digest(model);
    if (pass.provider !== "openai-codex") throw new Error("Reset pass provider is unsupported");
    this.#baseUrl = pass.codexBaseUrl && normalizeCodexBaseUrl(pass.codexBaseUrl);
    const registryBaseUrl = binding.modelRegistry.getProviderBaseUrl(pass.provider);
    this.#registryBaseUrl = registryBaseUrl && normalizeCodexBaseUrl(registryBaseUrl);
    const modelBaseUrl = model.baseUrl && normalizeCodexBaseUrl(model.baseUrl);
    if (this.#baseUrl !== (this.#registryBaseUrl ?? modelBaseUrl)) throw new Error("Reset pass endpoint changed before capture");
    this.#initialPolicy = policy(binding);
    if (!isDeepStrictEqual(this.#initialPolicy, pass.policy)) throw new Error("Reset pass policy changed before capture");
    const selection = binding.authStorage.captureSessionCredentialSelection(pass.provider, pass.nativeSessionId);
    if (!selection) throw new Error("Reset credential selection cannot be observed");
    this.#selection = clone(selection);
    for (const row of binding.authStorage.listOAuthAccounts("openai-codex", pass.nativeSessionId)) {
      if (!Number.isSafeInteger(row.credentialId)) continue;
      const evidence = binding.authStorage.getResetAccountEvidence("openai-codex", row.credentialId!);
      if (evidence) this.#accounts.set(row.credentialId!, Object.freeze({ evidence: clone(evidence), projected: projectAccount(evidence, this.#baseUrl) }));
    }
    const settingsObservation = binding.settings.captureResetPolicySettingsObservation();
    try {
      this.#settingsObservation = settingsObservation;
      this.#readback = binding.settings.capturePersistedReadback(RESET_PATHS);
      this.source = Object.freeze({ kind: "source" as const, selectionRevision: digest(this.#selection), policyRevision: this.#policyRevision });
      this.#unsubscribe = binding.session.subscribe(event => { if (event.type === "model_changed") this.#modelChanged = true; });
    } catch (error) {
      try { settingsObservation.dispose(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Reset pass capture and observation cleanup both failed"); }
      throw error;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true; const failures: unknown[] = [];
    try { this.#unsubscribe(); } catch (error) { failures.push(error); }
    try { this.#settingsObservation.dispose(); } catch (error) { failures.push(error); }
    this.#accounts.clear();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Reset pass context cleanup failed");
  }

  assertCurrent(): void {
    if (this.#disposed) throw new Error("Reset pass context is disposed");
    if (this.#modelChanged || this.#binding.session.sessionId !== this.#pass.nativeSessionId
      || this.#binding.session.settings !== this.#binding.settings || this.#binding.session.modelRegistry !== this.#binding.modelRegistry
      || this.#binding.modelRegistry.authStorage !== this.#binding.authStorage) throw new Error("Original reset session changed");
    const model = this.#binding.session.model;
    const registryBaseUrl = this.#binding.modelRegistry.getProviderBaseUrl(this.#pass.provider);
    if (!model || model !== this.#model || digest(model) !== this.#modelDigest
      || (registryBaseUrl && normalizeCodexBaseUrl(registryBaseUrl)) !== this.#registryBaseUrl)
      throw new Error("Reset pass model or endpoint changed");
    this.#settingsObservation.assertCurrent();
    if (!this.#binding.authStorage.isSessionCredentialSelectionCurrent(this.#selection)) throw new Error("Reset credential selection changed");
    for (const [credentialId, account] of this.#accounts) {
      if (!sameResetAccountEvidence(account.evidence, this.#binding.authStorage.getResetAccountEvidence("openai-codex", credentialId)))
        throw new Error("Reset account evidence changed");
    }
  }

  async plan(snapshot: ResetPlanSnapshot) {
    this.#assertSnapshot(snapshot); this.assertCurrent();
    if (this.#planned) throw new Error("Reset plan was already captured");
    const accounts = snapshot.plan.actions.map(action => {
      const matches = [...this.#accounts.values()].filter(account => Number.isSafeInteger(action.target.credentialId)
        ? account.evidence.credentialId === action.target.credentialId
        : action.target.accountId ? account.evidence.accountId === action.target.accountId
        : !!action.target.email && account.evidence.email?.trim().toLowerCase() === action.target.email.trim().toLowerCase());
      if (matches.length !== 1) throw new Error("Reset plan account was not uniquely captured before report I/O");
      return matches[0]!;
    });
    const persisted = await this.#readback.read(); this.assertCurrent();
    this.#planned = Object.freeze({ snapshot: clone(snapshot), accounts: Object.freeze(accounts.slice()), persisted });
    return Object.freeze({ kind: "plan" as const, accounts: Object.freeze(accounts.map(account => account.projected)) });
  }

  async persistence(snapshot: ResetPlanSnapshot, mode: "yes" | "no") {
    this.#assertPlanned(snapshot);
    if (this.#persistenceDone || !this.#decision?.recorded || (this.#decision.answer === "Yes" ? "yes" : this.#decision.answer === "No" ? "no" : undefined) !== mode)
      throw new Error("Native reset policy write does not match the original decision");
    this.#persistenceDone = true;
    this.#settingsObservation.adoptNativeAutoRedeemSet(mode);
    await this.#binding.settings.flush(); this.assertCurrent();
    const current = await this.#binding.settings.capturePersistedReadback(RESET_PATHS).read(); this.assertCurrent();
    const initial = this.#planned!.persisted;
    const verified = current.resetPolicyWriter.available && current.global["codexResets.autoRedeem"] === mode && sameHigherLayers(initial, current)
      && RESET_PATHS.slice(1).every(path => isDeepStrictEqual(initial.global[path], current.global[path]));
    if (!verified) throw new Error("Native reset policy write was not durably verified");
    this.#policyRevision = randomUUID();
    return Object.freeze({ kind: "persistence" as const, status: "verified" as const, globalMode: mode,
      effectivePolicy: policy(this.#binding), layersUnchanged: true, policyRevision: this.#policyRevision });
  }

  async admission(snapshot: ResetPlanSnapshot, actionIndex: number) {
    this.#assertPlanned(snapshot); this.assertCurrent();
    const planned = this.#planned!;
    if (!Number.isSafeInteger(actionIndex) || actionIndex < 0 || actionIndex >= snapshot.plan.actions.length) throw new Error("Reset action index is invalid");
    const action = snapshot.plan.actions[actionIndex]!, account = planned.accounts[actionIndex]!;
    const statuses = await this.#binding.session.listResetCredits(AbortSignal.timeout(10_000)); this.assertCurrent();
    const row = statuses.find(item => item.credentialId === account.evidence.credentialId);
    if (!row || row.error) throw new Error("Original reset account credit is unavailable");
    const credit = this.#credit(row, action.target);
    const evidence = Object.freeze({ kind: "admission" as const, selectionRevision: this.source.selectionRevision,
      policyRevision: this.#policyRevision, account: account.projected, credit });
    return { evidence, beforeConsume: (identity: ResetCreditConsumeIdentity) => {
      try { this.assertCurrent(); return identity.provider === "openai-codex" && identity.credentialId === account.evidence.credentialId
        && identity.creditId === credit.id && sameResetAccountEvidence(identity.resetAccountEvidence, account.evidence); }
      catch { return false; }
    } };
  }

  runDecision(bind: (interactionId: string) => Promise<void>, selectNative: () => Promise<NativeResetAnswer>): Promise<unknown> {
    this.assertCurrent();
    return this.#interactions.runWithDecisionBinding(bind, async () => {
      const answer = await selectNative(); this.assertCurrent();
      if (this.#decision) throw new Error("Native reset decision was already recorded");
      this.#decision = Object.freeze({ recorded: true, answer }); return answer;
    });
  }

  #assertSnapshot(snapshot: ResetPlanSnapshot): void {
    if (!isDeepStrictEqual(snapshot.pass, this.#pass)) throw new Error("Reset snapshot is not the original pass");
  }
  #assertPlanned(snapshot: ResetPlanSnapshot): void {
    this.#assertSnapshot(snapshot);
    if (!this.#planned || !isDeepStrictEqual(this.#planned.snapshot, snapshot)) throw new Error("Reset snapshot is not the captured plan");
  }
  #credit(row: ResetCreditAccountStatus, target: { credentialId?: number }): ResetPolicyWireCredit {
    if (target.credentialId !== undefined && target.credentialId !== row.credentialId) throw new Error("Reset action account changed");
    const credit = pickSoonestExpiringCredit(row.credits);
    if (!credit) throw new Error("Original reset credit is unavailable");
    return Object.freeze({ id: credit.id, status: "available", ...(credit.expiresAt ? { expiresAt: credit.expiresAt } : {}), fingerprint: digest(credit) });
  }
}
