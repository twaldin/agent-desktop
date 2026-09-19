import { normalizeCodexBaseUrl } from "@oh-my-pi/pi-ai/usage/openai-codex-base-url";
import { createHash, randomUUID } from "node:crypto";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import type { ResetCreditAccountStatus } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import { pickSoonestExpiringCredit, type CodexResetCredit } from "@oh-my-pi/pi-ai/usage/openai-codex-reset";
import { limitMatchesActiveAccount, reportMatchesActiveAccount } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/active-oauth-account";
import { projectNativeErrorMessage } from "../omp-workers/events";
import { SESSION_USAGE_MAX_BYTES, type SessionUsage, type UsageCredit, type UsageCreditAccount, type UsageRefresh, type UsageResetConfirmation, type UsageResetOutcome, type UsageResetPrepare } from "../../../../packages/shared/src/session-usage";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (value: unknown): string | undefined => typeof value === "string" ? projectNativeErrorMessage(value).replace(/[\u0000-\u001f]/g, " ").slice(0, 1024) : undefined;
const number = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const notes = (value: string[] | undefined) => [...(value ?? []).slice(0, 16).map(value => text(value)!), ...((value?.length ?? 0) > 16 ? ["Additional native notes omitted by the display limit."] : [])];
const strings = (value: object, keys: readonly string[]) => Object.fromEntries(keys.flatMap(key => {
  const item = text((value as Record<string, unknown>)[key]); return item === undefined ? [] : [[key, item]];
}));
const numbers = (value: object, keys: readonly string[]) => Object.fromEntries(keys.flatMap(key => {
  const item = number((value as Record<string, unknown>)[key]); return item === undefined ? [] : [[key, item]];
}));
export const projectUsageCredit = (credit: UsageCredit): UsageCredit => strings(credit, ["title", "description", "status", "resetType", "grantedAt", "expiresAt"]);
const available = (credit: CodexResetCredit) => !!credit.id && credit.id.length <= 200 && (credit.status ?? "available") === "available"
  && (!credit.expiresAt || !Number.isFinite(Date.parse(credit.expiresAt)) || Date.parse(credit.expiresAt) > Date.now());
const candidate = (row: ResetCreditAccountStatus) => !row.error && row.availableCount > 0
  ? pickSoonestExpiringCredit(row.credits.filter(available)) : undefined;
export function projectUsageReports(reports: UsageReport[], session: AgentSession): SessionUsage["reports"] {
  if (reports.length > 128 || reports.reduce((sum, report) => sum + report.limits.length, 0) > 2048) throw new Error("Native usage report exceeds the display limit.");
  return reports.map(report => {
    if ((report.resetCredits?.credits?.length ?? 0) > 128) throw new Error("Native report credit details exceed the display limit.");
    if (number(report.fetchedAt) === undefined) throw new Error("Native report has no valid evidence timestamp.");
    const identity = session.modelRegistry.authStorage.getOAuthAccountIdentity(report.provider, session.sessionId);
    return { provider: text(report.provider)!, fetchedAt: report.fetchedAt, active: reportMatchesActiveAccount(report, identity),
      identity: strings(report.metadata ?? {}, ["accountId", "account_id", "email", "projectId", "orgId", "orgName"]), notes: notes(report.notes),
      ...(report.resetCredits ? { resetCredits: { availableCount: report.resetCredits.availableCount, credits: (report.resetCredits.credits ?? []).slice(0, 128).map(projectUsageCredit) } } : {}),
      limits: report.limits.map(limit => ({ id: text(limit.id)!, label: text(limit.label)!, active: limitMatchesActiveAccount(report, limit, identity),
        scope: { provider: text(limit.scope.provider)!, ...strings(limit.scope, ["accountId", "projectId", "orgId", "modelId", "tier", "windowId"]), ...(typeof limit.scope.shared === "boolean" ? { shared: limit.scope.shared } : {}) },
        amount: { unit: text(limit.amount.unit) ?? "unknown", ...numbers(limit.amount, ["used", "limit", "remaining", "usedFraction", "remainingFraction"]) },
        ...(limit.window ? { window: { id: text(limit.window.id)!, label: text(limit.window.label)!, ...strings(limit.window, ["resetLabel"]), ...numbers(limit.window, ["durationMs", "resetsAt"]) } } : {}),
        ...(limit.status ? { status: text(limit.status) } : {}), notes: notes(limit.notes),
      })),
    };
  });
}
/** Account collision identity is independent of cosmetic email aliases when accountId is proven.
 * Email-only callers must first reject ambiguous rows in the original native account list. */
export function nativeResetAccountKey(identity: { provider: string; accountId?: string; email?: string; orgId?: string; projectId?: string }, baseUrl?: string): string {
  if (identity.provider !== "openai-codex" || !identity.accountId && !identity.email?.trim()) throw new Error("Native reset account identity is unresolved.");
  return hash({ provider: identity.provider, endpoint: normalizeCodexBaseUrl(baseUrl), identity: identity.accountId ? { accountId: identity.accountId } : { email: identity.email!.trim().toLowerCase() }, orgId: identity.orgId, projectId: identity.projectId });
}
export interface NativeUsagePreparation { ticket: string; epoch: string; accountKey: string; confirmation: UsageResetConfirmation }
export interface NativeUsageResult { state: "settled" | "rejected" | "unknown"; outcome?: UsageResetOutcome }
interface Ticket { fingerprint: string; credentialId: number; identity: string; creditId: string; credit: string; confirmation: UsageResetConfirmation; used: boolean }

/** Uses the owning session's native auth and provider registry, never a second auth store. */
export class NativeSessionUsage {
  readonly epoch = randomUUID();
  #revision = randomUUID();
  #snapshot: SessionUsage | null = null;
  #rows = new Map<string, ResetCreditAccountStatus>();
  #tickets = new Map<string, Ticket>();
  #busy = false;
  #sessionId: string;
  #unsubscribe: () => void;
  constructor(private session: AgentSession, private assertReady: () => void, private assertActive: () => void) {
    this.#sessionId = session.sessionId;
    this.#unsubscribe = session.subscribe(event => { if (event.type === "model_changed") this.#revision = randomUUID(); });
  }
  dispose() { this.#unsubscribe(); this.#tickets.clear(); this.#rows.clear(); }
  get busy() { return this.#busy; }
  #policy(): SessionUsage["policy"] { return this.session.settings.getGroup("codexResets"); }
  #fingerprint() {
    this.assertActive();
    if (this.session.sessionId !== this.#sessionId) throw new Error("Original usage session changed.");
    return hash({ revision: this.#revision, model: this.session.model && { id: this.session.model.id, provider: this.session.model.provider },
      policy: this.#policy(), resetEndpoint: normalizeCodexBaseUrl(this.#resetBaseUrl("openai-codex")), antigravityEndpoint: this.#baseUrl("google-antigravity"), accounts: this.session.modelRegistry.authStorage.listOAuthAccounts("openai-codex", this.#sessionId),
      selected: this.session.model && this.session.modelRegistry.authStorage.listOAuthAccounts(this.session.model.provider, this.#sessionId) });
  }
  #current(fingerprint: string) { if (fingerprint !== this.#fingerprint()) throw new Error("Usage account, selection or policy changed. Refresh and prepare a new confirmation."); }
  async #revalidate(fingerprint: string) { this.#current(fingerprint); await this.session.modelRegistry.authStorage.revalidateCredentials(); this.#current(fingerprint); }
  #baseUrl = (provider: string) => {
    if (provider === "google-antigravity") {
      const mode = this.session.settings.get("providers.antigravityEndpoint");
      if (mode === "sandbox") return "https://daily-cloudcode-pa.sandbox.googleapis.com";
      if (mode === "production") return "https://daily-cloudcode-pa.googleapis.com";
    }
    return this.session.modelRegistry.getProviderBaseUrl?.(provider);
  };
  #resetBaseUrl = (provider: string) => this.session.modelRegistry.getProviderBaseUrl?.(provider);
  #rowIdentity(row: Pick<ResetCreditAccountStatus, "accountId" | "email"> & { orgId?: string; projectId?: string }) {
    return hash({ accountId: row.accountId, email: row.email, orgId: row.orgId, projectId: row.projectId });
  }
  #projectAccount(ref: string, row: ResetCreditAccountStatus): UsageCreditAccount {
    const stored = this.session.modelRegistry.authStorage.listOAuthAccounts("openai-codex", this.#sessionId).find(item => item.credentialId === row.credentialId);
    return { accountRef: ref, ...strings(row, ["accountId", "email"]), ...strings(stored ?? {}, ["orgId", "projectId"]), active: stored?.active ?? false,
      ...(row.error ? { unavailable: "Native saved-credit inspection failed for this account." } : { availableCount: row.availableCount }),
      credits: row.credits.map(projectUsageCredit), canPrepare: !!stored && Number.isSafeInteger(row.credentialId) && !!candidate(row) };
  }
  async #run<T>(run: () => Promise<T>): Promise<T> {
    if (this.#busy) throw new Error("A provider usage operation is already running.");
    this.assertReady(); this.#busy = true;
    try { return await run(); } finally { this.#busy = false; }
  }
  read(mode: UsageRefresh): Promise<SessionUsage | null> {
    if (mode === "cached") { this.assertActive(); return Promise.resolve(this.#snapshot); }
    return this.#run(async () => {
      const auth = this.session.modelRegistry.authStorage, before = this.#fingerprint();
      await auth.revalidateCredentials(); this.#current(before);
      const value: SessionUsage = this.#snapshot && this.#snapshot.revision === before ? structuredClone(this.#snapshot) : {
        version: 1, sessionId: this.#sessionId, epoch: this.epoch, revision: before,
        ...(this.session.model ? { model: { id: this.session.model.id, provider: this.session.model.provider } } : {}),
        reports: [], reportStatus: "not-loaded", credits: [], modelSelectors: [], policy: this.#policy(),
      };
      if (mode === "reports") {
        // AgentSession.fetchUsageReports also starts a potentially spending sweep. U2 owns that lifecycle.
        const reports = await auth.fetchUsageReports({ baseUrlResolver: this.#baseUrl, signal: AbortSignal.timeout(45_000) }); await this.#revalidate(before);
        value.reports = projectUsageReports(reports ?? [], this.session);
        value.modelSelectors = this.session.getUsageReportingModelSelectors(reports ?? []);
        if (value.modelSelectors.length > 2048) throw new Error("Native usage model selectors exceed the display limit.");
        value.reportStatus = reports === null ? "unsupported" : "available"; value.reportsCheckedAt = Date.now();
      } else {
        const rows = await this.session.listResetCredits(AbortSignal.timeout(45_000)); await this.#revalidate(before);
        if (rows.length > 128 || rows.some(row => row.credits.length > 128)) throw new Error("Native saved-credit list exceeds the display limit.");
        this.#rows.clear(); value.credits = rows.map(row => { const ref = randomUUID(); this.#rows.set(ref, row); return this.#projectAccount(ref, row); });
        value.creditsCheckedAt = Date.now();
      }
      if (Buffer.byteLength(JSON.stringify(value)) > SESSION_USAGE_MAX_BYTES - 16_384) throw new Error("Native usage report exceeds the display limit.");
      this.#snapshot = value; return structuredClone(value);
    });
  }
  prepare(request: UsageResetPrepare): Promise<NativeUsagePreparation> {
    return this.#run(async () => {
      if (request.sessionId !== this.#sessionId || request.epoch !== this.epoch || request.revision !== this.#fingerprint()) throw new Error("Refresh this original session's saved credits before preparing a reset.");
      const original = this.#rows.get(request.accountRef), fingerprint = this.#fingerprint();
      if (!original || !Number.isSafeInteger(original.credentialId)) throw new Error("Unknown saved-credit account.");
      await this.session.modelRegistry.authStorage.revalidateCredentials(); this.#current(fingerprint);
      const rows = await this.session.listResetCredits(AbortSignal.timeout(45_000)); await this.#revalidate(fingerprint);
      const row = rows.find(row => row.credentialId === original.credentialId);
      if (!row || !row.accountId && (!row.email || rows.filter(other => other.email?.trim().toLowerCase() === row.email?.trim().toLowerCase()).length !== 1) || this.#rowIdentity(row) !== this.#rowIdentity(original)) throw new Error("Saved-credit account changed.");
      const credit = candidate(row); if (!credit) throw new Error("No identified available credit can be confirmed for this account.");
      for (const [id, ticket] of this.#tickets) if (ticket.confirmation.expiresAt < Date.now() || ticket.used) this.#tickets.delete(id);
      if (this.#tickets.size >= 32) throw new Error("Too many pending saved-reset confirmations.");
      const account = this.#projectAccount(request.accountRef, row);
      const confirmation: UsageResetConfirmation = { account: { accountRef: account.accountRef, accountId: account.accountId, email: account.email, orgId: account.orgId, projectId: account.projectId, active: account.active }, credit: projectUsageCredit(credit), creditReference: hash(credit.id).slice(0, 16), expiresAt: Date.now() + 300_000 };
      const ticket = randomUUID(); this.#tickets.set(ticket, { fingerprint, credentialId: row.credentialId!, identity: this.#rowIdentity(account), creditId: credit.id, credit: hash(credit), confirmation, used: false });
      return { ticket, epoch: this.epoch, accountKey: nativeResetAccountKey({ provider: "openai-codex", ...account }, this.#resetBaseUrl("openai-codex")), confirmation };
    });
  }
  redeem(ticketId: string, redeemRequestId: string): Promise<NativeUsageResult> {
    return this.#run(async () => {
      const ticket = this.#tickets.get(ticketId);
      if (!ticket || ticket.used) return { state: "rejected", outcome: "admission_rejected" };
      ticket.used = true;
      const current = () => { this.#current(ticket.fingerprint); if (ticket.confirmation.expiresAt <= Date.now()) throw new Error("Reset confirmation expired."); };
      const auth = this.session.modelRegistry.authStorage;
      try {
        current(); await auth.revalidateCredentials(); current();
        const rows = await this.session.listResetCredits(AbortSignal.timeout(45_000)); await this.#revalidate(ticket.fingerprint); current();
        const row = rows.find(row => row.credentialId === ticket.credentialId), credit = row?.credits.find(credit => credit.id === ticket.creditId);
        if (!row || row.error || !credit || !available(credit) || hash(credit) !== ticket.credit) return { state: "rejected", outcome: "admission_rejected" };
      } catch { return { state: "rejected", outcome: "admission_rejected" }; }
      try {
        const result = await auth.redeemResetCredit({ target: { credentialId: ticket.credentialId }, creditId: ticket.creditId,
          redeemRequestId, requireExplicitOutcome: true, baseUrlResolver: this.#resetBaseUrl, signal: AbortSignal.timeout(45_000),
          beforeConsume: identity => {
            try { current(); return identity.provider === "openai-codex" && identity.credentialId === ticket.credentialId
              && identity.creditId === ticket.creditId && this.#rowIdentity(identity) === ticket.identity; } catch { return false; }
          },
        });
        const known: UsageResetOutcome[] = ["reset", "already_redeemed", "no_credit", "nothing_to_reset", "no_account", "account_unavailable", "credit_list_failed", "admission_rejected"];
        if (!known.includes(result.code as UsageResetOutcome) || result.ok !== (result.code === "reset")) return { state: "unknown" };
        return { state: result.code === "admission_rejected" ? "rejected" : "settled", outcome: result.code as UsageResetOutcome };
      } catch { return { state: "unknown" }; }
    });
  }
}
